export interface StayView {
  verified: boolean;
  hotel: { name: string; address: string | null; city: string | null; country: string; phone: string | null; email: string | null; checkInTime: string; checkOutTime: string };
  booking: {
    code: string;
    status: string;
    arrival: string;
    departure: string;
    nights: number;
    adults: number;
    children: number;
    roomType: string;
    ratePlan: string;
    includesBreakfast: boolean;
    currency: string;
    total: number;
    paid: number;
    balance: number;
    awaitingPayment: boolean;
    estimatedArrival: string | null;
    requests: string | null;
    onlineCheckinAt: string | null;
    locale: string;
  };
  guest: { firstName: string; lastName: string | null; email: string | null };
  checkin: {
    mainGuest: { birthDate: string | null; nationality: string | null; documentType: string | null; documentNumber: string | null; address: string | null; country: string | null };
    companions: { firstName: string; lastName: string; birthDate: string | null; nationality: string | null; documentType: string | null; documentNumber: string | null }[];
  } | null;
}
