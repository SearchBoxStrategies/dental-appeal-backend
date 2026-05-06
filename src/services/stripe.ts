import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia',
});

export interface CreateCheckoutSessionParams {
  customerId?: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  userId: number;
  practiceId: number;
}

export const createCheckoutSession = async (params: CreateCheckoutSessionParams) => {
  const { customerId, priceId, successUrl, cancelUrl, userId, practiceId } = params;

  try {
    let customer = customerId;
    
    if (!customer) {
      const newCustomer = await stripe.customers.create({
        metadata: {
          userId: userId.toString(),
          practiceId: practiceId.toString(),
        },
      });
      customer = newCustomer.id;
      
      const { db } = await import('../db');
      await db.query(
        'UPDATE practices SET stripe_customer_id = $1 WHERE id = $2',
        [customer, practiceId]
      );
    }

    const session = await stripe.checkout.sessions.create({
      customer,
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        userId: userId.toString(),
        practiceId: practiceId.toString(),
      },
      subscription_data: {
        metadata: {
          userId: userId.toString(),
          practiceId: practiceId.toString(),
        },
      },
    });

    return { url: session.url, sessionId: session.id };
  } catch (error) {
    console.error('Stripe checkout error:', error);
    throw error;
  }
};

export const createCustomerPortalSession = async (customerId: string, returnUrl: string) => {
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return { url: session.url };
  } catch (error) {
    console.error('Stripe portal error:', error);
    throw error;
  }
};

export const handleWebhookEvent = async (event: Stripe.Event) => {
  const { db } = await import('../db');
  
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.userId;
      const practiceId = session.metadata?.practiceId;
      const subscriptionId = session.subscription as string;
      
      if (userId && practiceId) {
        await db.query(
          `UPDATE practices 
           SET subscription_status = 'active', 
               stripe_subscription_id = $1 
           WHERE id = $2`,
          [subscriptionId, practiceId]
        );
      }
      break;
    }
    
    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription;
      const practiceId = subscription.metadata?.practiceId;
      const status = subscription.status;
      
      if (practiceId) {
        await db.query(
          'UPDATE practices SET subscription_status = $1 WHERE id = $2',
          [status === 'active' ? 'active' : status, practiceId]
        );
      }
      break;
    }
    
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const practiceId = subscription.metadata?.practiceId;
      
      if (practiceId) {
        await db.query(
          'UPDATE practices SET subscription_status = $1 WHERE id = $2',
          ['cancelled', practiceId]
        );
      }
      break;
    }
    
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice;
      const subscription = await stripe.subscriptions.retrieve(invoice.subscription as string);
      const practiceId = subscription.metadata?.practiceId;
      const amountPaid = invoice.amount_paid / 100;
      
      if (practiceId) {
        await db.query(
          `UPDATE practices 
           SET total_paid = COALESCE(total_paid, 0) + $1,
               last_payment_date = NOW(),
               last_payment_amount = $1
           WHERE id = $2`,
          [amountPaid, practiceId]
        );
      }
      break;
    }
    
    default:
      console.log(`Unhandled event type: ${event.type}`);
  }
  
  return { received: true };
};

export default stripe;
