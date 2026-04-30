export interface JwtPayload {
  userId: string;
  practiceId: string;
  role: string;
  practiceName: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}
