import { describe, it, expect } from "vitest";
import { interpolatePinElevation } from "../utils/pinElevation";

// The green's front→back axis runs north (lat increases), centred at
// (12.9718, 77.5946). Front sits 0.0001° south, back 0.0001° north.
const FRONT_LAT = 12.9717, FRONT_LNG = 77.5946;
const CENTRE_LAT = 12.9718, CENTRE_LNG = 77.5946;
const BACK_LAT = 12.9719, BACK_LNG = 77.5946;

describe("interpolatePinElevation", () => {
  it("returns centre elevation when the pin sits at the green centre", () => {
    const v = interpolatePinElevation(
      CENTRE_LAT, CENTRE_LNG,
      FRONT_LAT, FRONT_LNG, CENTRE_LAT, CENTRE_LNG, BACK_LAT, BACK_LNG,
      { front: 100, centre: 102, back: 104 },
    );
    expect(v).toBeCloseTo(102, 5);
  });

  it("returns front elevation when the pin sits at the front edge", () => {
    const v = interpolatePinElevation(
      FRONT_LAT, FRONT_LNG,
      FRONT_LAT, FRONT_LNG, CENTRE_LAT, CENTRE_LNG, BACK_LAT, BACK_LNG,
      { front: 100, centre: 102, back: 104 },
    );
    expect(v).toBeCloseTo(100, 5);
  });

  it("returns back elevation when the pin sits at the back edge", () => {
    const v = interpolatePinElevation(
      BACK_LAT, BACK_LNG,
      FRONT_LAT, FRONT_LNG, CENTRE_LAT, CENTRE_LNG, BACK_LAT, BACK_LNG,
      { front: 100, centre: 102, back: 104 },
    );
    expect(v).toBeCloseTo(104, 5);
  });

  it("interpolates linearly between centre and back for a back pin", () => {
    // Pin at 75% from front toward back → halfway between centre and back.
    const pinLat = FRONT_LAT + (BACK_LAT - FRONT_LAT) * 0.75;
    const v = interpolatePinElevation(
      pinLat, CENTRE_LNG,
      FRONT_LAT, FRONT_LNG, CENTRE_LAT, CENTRE_LNG, BACK_LAT, BACK_LNG,
      { front: 100, centre: 102, back: 104 },
    );
    expect(v).toBeCloseTo(103, 5);
  });

  it("clamps pins beyond the green back to the back elevation", () => {
    const beyondLat = BACK_LAT + (BACK_LAT - FRONT_LAT); // way past back
    const v = interpolatePinElevation(
      beyondLat, CENTRE_LNG,
      FRONT_LAT, FRONT_LNG, CENTRE_LAT, CENTRE_LNG, BACK_LAT, BACK_LNG,
      { front: 100, centre: 102, back: 104 },
    );
    expect(v).toBeCloseTo(104, 5);
  });

  it("falls back to centre elevation for a degenerate (zero-length) green axis", () => {
    const v = interpolatePinElevation(
      CENTRE_LAT, CENTRE_LNG,
      CENTRE_LAT, CENTRE_LNG, CENTRE_LAT, CENTRE_LNG, CENTRE_LAT, CENTRE_LNG,
      { front: 100, centre: 102, back: 104 },
    );
    expect(v).toBe(102);
  });
});
