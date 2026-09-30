// Surface transit vehicle as an obstacle for the road traffic sim (TransitLayer.groundVehicles).
export interface GroundVeh {
  /** front-centre position (world E/N) */
  e: number;
  n: number;
  /** rad CCW from +E */
  heading: number;
  length: number;
  width: number;
  speed: number;
  trip: number;
  /** rail vehicle (streetcar / LRT) */
  rail?: boolean;
  /** doors open (Toronto: traffic stops behind a streetcar with open doors); undefined = unknown */
  doorsOpen?: boolean;
}
