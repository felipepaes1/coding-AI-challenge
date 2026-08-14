export interface Car {
  id: string;
  make: string;
  model: string;
  year: number;
  color: string;
  mobile: string;
  tablet: string;
  desktop: string;
}

/** The normalized result shape consumed by inventory views. */
export interface GetCarsData {
  cars: Car[];
}

/** Component-facing state for the inventory request lifecycle. */
export type InventoryState =
  | { status: "loading"; cars: Car[] }
  | { status: "error"; cars: Car[]; error: Error }
  | { status: "success"; cars: Car[] };
