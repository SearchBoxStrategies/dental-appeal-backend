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
  referralCode?: string; // ADDED
}

export const createCheckoutSession = async (params: CreateCheckoutSessionParams) => {
  const { customerId, priceId, successUrl, cancelUrl, userId, practiceId, referralCode } = params;

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
        referralCode: referralCode || '', // ADDED
      },
      subscription_data: {
        metadata: {
          userId: userId.toString(),
          practiceId: practiceId.toString(),
          referralCode: referralCode || '', // ADDED
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

export default stripe;
