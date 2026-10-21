export type RoomState = 'in_house' | 'ready' | 'dirty' | 'free' | 'out';

export interface HouseRoom {
  id: string;
  number: string;
  floor: string;
  roomType: string;
  roomTypeCode: string;
  status: string;
  state: RoomState;
  stay: { reservationId: string; code: string; guestName: string | null; departure: string; departsToday: boolean; guests: number; balance: number | null } | null;
  arrival: { reservationId: string; code: string; guestName: string | null; time: string; onlineCheckin: boolean } | null;
}

export interface HouseArrival {
  reservationId: string;
  code: string;
  guestName: string;
  time: string;
  roomNumber: string | null;
  roomReady: boolean;
  roomType: string;
  ratePlan: string;
  nights: number;
  guests: number;
  onlineCheckin: boolean;
  requests: string | null;
}

export interface House {
  businessDate: string;
  currency: string;
  timezone: string;
  rooms: HouseRoom[];
  counts: { sellable: number; occupied: number; occupancy: number; ready: number; dirty: number; free: number; guestsInHouse: number; departuresLeft: number };
  arrivals: HouseArrival[];
  suggestions: { reservationId: string; guestName: string | null; time: string; roomId: string; number: string; ready: boolean }[];
  housekeeping: { name: string | null; open: number; done: number; floors: string[] }[];
}

export type DayLane = 'arrivals' | 'departures' | 'housekeeping' | 'money';

export interface DayItem {
  lane: DayLane;
  time: string;
  title: string;
  sub: string;
  state: 'done' | 'plan' | 'warn' | 'span' | 'key';
  reservationId?: string;
}

export interface Day {
  date: string;
  businessDate: string;
  currency: string;
  now: string | null;
  checkInTime: string;
  checkOutTime: string;
  items: DayItem[];
}

export interface Night {
  businessDate: string;
  currency: string;
  timezone: string;
  now: string;
  checks: { key: 'departures' | 'arrivals' | 'housekeeping' | 'balances'; done: boolean; count: number }[];
  ready: boolean;
  stillToArrive: { reservationId: string; guestName: string; time: string; room: string | null; roomReady: boolean; onlineCheckin: boolean; paid: boolean | null; requests: string | null }[];
  owes: { reservationId: string; guestName: string | null; room: string | null; departure: string; balance: number }[];
  tonight: { occupied: number; sellable: number; guests: number; breakfastTomorrow: number; revenueToday: number | null };
}
