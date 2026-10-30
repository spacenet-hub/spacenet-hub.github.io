"use strict";
/* =========================================================================
   CONSTELLATION ARCHITECT
   -------------------------------------------------------------------------
   A single-page LEO constellation design game.

   Physics
   -------
   Every satellite is on a circular orbit at the same mean altitude and is
   propagated analytically in Earth-Centered Inertial (ECI) coordinates.
   The secular J2 perturbation (Earth's oblateness) is included to first
   order. It does not change a, e or i, but it makes the mean motion and the
   RAAN drift depend on inclination:

       n_J2    = n0 [1 + 3/4 J2 (R/a)^2 (3 cos^2 i - 1)]
       RAANdot = -3/2 n0 J2 (R/a)^2 cos i

       u(t)   = M0 + n_J2 t
       RAAN(t)= RAAN0 + RAANdot t
       r_PQW  = [a cos u, a sin u, 0]
       r_ECI  = Rz(RAAN(t)) Rx(i) r_PQW

   For a circular orbit the perigee is degenerate, so only the sum of the
   argument of perigee and the mean anomaly is physical. The model fixes the
   undefined perigee and uses the J2-corrected mean motion as the along-track
   rate; this keeps e = 0 well defined while retaining the inclination-
   dependent along-track drift. Different inclinations therefore precess in
   RAAN and drift along-track at different rates, which is the physically
   important J2 effect for constellation design.

   Safety is decided only by propagating the constellation and taking
   pairwise 3D Euclidean distances. There are no scripted or random
   collision events.

   Analysis
   --------
   1. J2 destroys the old shortcut that relative geometry repeats every
      orbital period: two planes with different inclinations drift apart in
      RAAN over the day. The full constellation is therefore propagated for
      the entire 24 hours at 10 s.
   2. The official 300 s screening profile is sampled from the same pass,
      so the chart and the safety decision use identical trajectories.
   3. Candidate minima below 250 km are refined with a golden-section
      search, giving a precise closest-approach distance and time.
   ========================================================================= */

/* =========================================================================
   CONSTANTS
   ========================================================================= */
const MU = 398600.4418;                 // km^3 / s^2
const R_E = 6371.0;                     // km, mean Earth radius
const ALTITUDE = 550.0;                 // km, common constellation altitude
const A_SMA = R_E + ALTITUDE;           // km, semi-major axis
const N_MEAN = Math.sqrt(MU / (A_SMA * A_SMA * A_SMA)); // rad/s, Keplerian
const J2 = 1.08262668e-3;               // Earth's second zonal harmonic
const WE = 7.2921159e-5;                // rad/s, Earth rotation
const DAY = 86400;                      // s
const COARSE_STEP = 300;                // s, profile / screening timestep
const FINE_STEP = 10;                   // s, full-day conjunction sweep timestep
const SAFE_KM = 10;                     // > 10 km  => SAFE
const COLLISION_KM = 1;                 // <  1 km  => COLLISION
const MAX_SATS = 120;
const PLANE_BONUS = 50;
const SAT_POINTS = 10;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const PLANE_COLORS = [
  "#46d8ff", "#9b8cff", "#ffd166", "#45e6a0", "#ff8bd1",
  "#ff9d5c", "#7dffcb", "#b7a6ff", "#6ea8ff", "#f3e38a",
  "#57e0d0", "#ff7ea8"
];

const MILESTONES = [
  { n: 10,  bonus: 250,  text: "10 satellites deployed" },
  { n: 25,  bonus: 500,  text: "25 satellites deployed" },
  { n: 50,  bonus: 1000, text: "50 satellites deployed" },
  { n: 100, bonus: 2500, text: "100 satellites deployed" }
];

/* =========================================================================
   SMALL MATH HELPERS
   ========================================================================= */
const clamp = (x, lo, hi) => x < lo ? lo : (x > hi ? hi : x);

function wrap360(d) {
  d %= 360;
  if (d < 0) d += 360;
  return d;
}

function angleDiff(a, b) {
  const d = Math.abs(wrap360(a) - wrap360(b));
  return d > 180 ? 360 - d : d;
}

function mod(x, m) {
  return ((x % m) + m) % m;
}

/* =========================================================================
   GAME STATE
   ========================================================================= */
const state = {
  planes: [],            // committed planes
  sats: [],              // flattened committed satellites
  nextPlaneId: 1,
  score: 0,
  milestones: new Set(),

  analysis: null,        // analysis of the committed constellation
  lastFeedback: "",      // HTML explanation for the committed constellation
  preview: null,         // { params, plane, analysis, feedback, overflow }
  previewArmed: false,   // becomes true once the player touches a control
  previewTimer: null,

  simTime: 0,            // seconds, continuous (clock displays time-of-day)
  speed: 300,
  paused: false,

  cam: { yaw: 0.58, pitch: 0.36, zoom: 1 },
  dragging: false,
  hoverSat: null,
  screenSats: [],        // populated by the renderer for hit-testing
  focus: null,           // { sats: [a, b], t: seconds } closest-pass highlight

  resetArmed: false,
  resetTimer: null,

  liveMin: Infinity,
  livePair: null,
  lastHudUpdate: 0
};

/* =========================================================================
   ORBITAL MECHANICS
   ========================================================================= */

/**
 * First-order secular J2 rates for a circular orbit at A_SMA.
 *
 * J2 is axisymmetric, so in the orbit-averaged (secular) model the
 * semi-major axis, eccentricity and inclination stay constant. What changes
 * is the orientation of the orbit: the node regresses and the argument of
 * latitude advances at a slightly different rate. Both rates depend on
 * inclination, which is exactly why mixed-inclination constellations cannot
 * be treated as repeating every Keplerian period.
 *
 * For a circular orbit the argument of perigee is undefined, so the model
 * fixes it and propagates the J2-corrected mean motion as the along-track
 * rate. The perigee precession is a gauge choice at e = 0 and is not added
 * separately.
 *
 * @param {number} incDeg inclination in degrees
 * @returns {{n:number, raanDot:number}} rad/s
 */
function j2Rates(incDeg) {
  const inc = incDeg * D2R;
  const cosI = Math.cos(inc);
  const cosI2 = cosI * cosI;
  const fac = J2 * (R_E / A_SMA) * (R_E / A_SMA);

  // RAAN is singular at i = 0: the node is undefined, so a finite nodal
  // rate would incorrectly rotate an equatorial orbit's phase. Fade the
  // nodal rate to zero over the first 2 degrees. The physical plane change
  // suppressed by this is O(sin i * RAANdot), below 0.04 deg/day.
  const s = clamp(incDeg / 2, 0, 1);
  const nodeScale = s * s * (3 - 2 * s);

  return {
    // J2-corrected mean motion (used as the along-track rate for e = 0).
    n: N_MEAN * (1 + 0.75 * fac * (3 * cosI2 - 1)),
    // Secular nodal regression: west for prograde, east for retrograde.
    raanDot: -1.5 * N_MEAN * fac * cosI * nodeScale
  };
}

/** Build one satellite on a circular J2-precessing orbit. */
function createSat(plane, index) {
  const inc = plane.inc * D2R;
  const rates = j2Rates(plane.inc);
  return {
    plane,
    index,
    a: A_SMA,                                          // semi-major axis, km
    inc: plane.inc,                                    // inclination, deg
    raan: plane.raan,                                  // RAAN at epoch, deg
    m0: (plane.phase + index * 360 / plane.count) * D2R, // mean anomaly at epoch
    cI: Math.cos(inc),
    sI: Math.sin(inc),
    raanDot: rates.raanDot,                            // rad/s
    uDot: rates.n,                                     // rad/s, argument of latitude
    label: plane.label + "-S" + (index + 1)
  };
}

/** Build a plane of evenly phased circular orbits. */
function createPlane(params, id) {
  const plane = {
    id,
    label: "P" + id,
    inc: params.inc,
    raan: params.raan,
    count: params.count,
    phase: params.phase,
    raanDot: j2Rates(params.inc).raanDot,              // rad/s
    color: PLANE_COLORS[(id - 1) % PLANE_COLORS.length],
    sats: []
  };
  for (let k = 0; k < params.count; k++) plane.sats.push(createSat(plane, k));
  return plane;
}

/**
 * Propagate one satellite to time t (seconds from epoch).
 * Writes [x, y, z] in ECI kilometres into `out`.
 */
function satPos(sat, t, out) {
  const u = sat.m0 + sat.uDot * t;
  const raan = sat.raan * D2R + sat.raanDot * t;
  const cu = Math.cos(u);
  const su = Math.sin(u);
  const cO = Math.cos(raan);
  const sO = Math.sin(raan);
  const a = sat.a;
  out[0] = a * (cO * cu - sO * sat.cI * su);
  out[1] = a * (sO * cu + cO * sat.cI * su);
  out[2] = a * (sat.sI * su);
  return out;
}

/** Position of a point at argument of latitude u on a plane's ring at time t. */
function planePos(plane, u, out, t = 0) {
  const raan = plane.raan * D2R + plane.raanDot * t;
  const cO = Math.cos(raan);
  const sO = Math.sin(raan);
  const cI = Math.cos(plane.inc * D2R);
  const sI = Math.sin(plane.inc * D2R);
  const cu = Math.cos(u);
  const su = Math.sin(u);
  out[0] = A_SMA * (cO * cu - sO * cI * su);
  out[1] = A_SMA * (sO * cu + cO * cI * su);
  out[2] = A_SMA * (sI * su);
  return out;
}

/** Squared distance between two satellites at time t. */
const _pa = [0, 0, 0];
const _pb = [0, 0, 0];
function pairSqDist(satA, satB, t) {
  satPos(satA, t, _pa);
  satPos(satB, t, _pb);
  const dx = _pa[0] - _pb[0];
  const dy = _pa[1] - _pb[1];
  const dz = _pa[2] - _pb[2];
  return dx * dx + dy * dy + dz * dz;
}

/** Golden-section minimization of squared distance around t0. */
function refineClosest(satA, satB, t0, halfWindow) {
  const phi = (Math.sqrt(5) - 1) / 2;
  let lo = Math.max(0, t0 - halfWindow);
  let hi = Math.min(DAY, t0 + halfWindow);
  let c = hi - phi * (hi - lo);
  let d = lo + phi * (hi - lo);
  let fc = pairSqDist(satA, satB, c);
  let fd = pairSqDist(satA, satB, d);

  for (let k = 0; k < 44; k++) {
    if (fc < fd) {
      hi = d;
      d = c;
      fd = fc;
      c = hi - phi * (hi - lo);
      fc = pairSqDist(satA, satB, c);
    } else {
      lo = c;
      c = d;
      fc = fd;
      d = lo + phi * (hi - lo);
      fd = pairSqDist(satA, satB, d);
    }
  }

  const t = (lo + hi) / 2;
  return { d2: pairSqDist(satA, satB, t), t };
}

/** Classify a closest-approach distance. */
function statusFor(distance) {
  if (distance < COLLISION_KM) return "COLLISION";
  if (distance < SAFE_KM) return "DANGEROUS";
  return "SAFE";
}

/* =========================================================================
   CONJUNCTION ANALYSIS
   ========================================================================= */
/**
 * Analyze a full satellite list over 24 hours.
 *
 * @param {Array} sats
 * @param {Object} [opts]
 * @returns {Object} analysis result
 */
function analyzeConstellation(sats, opts = {}) {
  const started = performance.now();
  const n = sats.length;
  const coarseSteps = Math.ceil(DAY / COARSE_STEP);      // 289 profile samples
  const fineSteps = Math.round(DAY / FINE_STEP);         // 8640 ten-second intervals
  const coarseStride = Math.round(COARSE_STEP / FINE_STEP); // 30 fine steps per profile sample

  if (n < 2) {
    return {
      sats,
      pair: null,
      minSep: Infinity,
      minTime: 0,
      status: "SAFE",
      profile: new Float64Array(coarseSteps + 1).fill(Infinity),
      epochs: coarseSteps + 1,
      fineSamples: fineSteps + 1,
      pairCount: 0,
      refined: false,
      coarseMin: Infinity,
      coarseTime: 0,
      coarsePair: [0, 0],
      durationMs: 0
    };
  }

  const profile = new Float64Array(coarseSteps + 1).fill(Infinity);
  const pos = new Float64Array(n * 3);
  const pairCount = n * (n - 1) / 2;

  const pairMinSq = new Float64Array(pairCount).fill(Infinity);
  const pairTime = new Float64Array(pairCount);
  const pairI = new Int16Array(pairCount);
  const pairJ = new Int16Array(pairCount);

  // The pair table is fixed for the whole sweep; build it once.
  let q = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      pairI[q] = i;
      pairJ[q] = j;
      q++;
    }
  }

  let coarseBestSq = Infinity;
  let coarseTime = 0;
  let coarsePair = [0, 1];
  let fineBestSq = Infinity;
  let fineBestPair = 0;
  let fineBestT = 0;

  /* ---- single 24 h propagation at 10 s ----
     J2 makes the mean motion and RAAN drift inclination-dependent, so the
     relative geometry no longer repeats each orbital period. The whole day
     must be screened; the 300 s profile is sampled from this same pass. */
  for (let k = 0; k <= fineSteps; k++) {
    const t = k * FINE_STEP;

    for (let i = 0; i < n; i++) {
      satPos(sats[i], t, _pa);
      pos[i * 3] = _pa[0];
      pos[i * 3 + 1] = _pa[1];
      pos[i * 3 + 2] = _pa[2];
    }

    let stepMinSq = Infinity;
    let stepMinPair = 0;
    q = 0;

    for (let i = 0; i < n; i++) {
      const ix = i * 3;
      const x1 = pos[ix], y1 = pos[ix + 1], z1 = pos[ix + 2];
      for (let j = i + 1; j < n; j++) {
        const jx = j * 3;
        const dx = x1 - pos[jx];
        const dy = y1 - pos[jx + 1];
        const dz = z1 - pos[jx + 2];
        const d2 = dx * dx + dy * dy + dz * dz;

        if (d2 < stepMinSq) {
          stepMinSq = d2;
          stepMinPair = q;
        }
        if (d2 < pairMinSq[q]) {
          pairMinSq[q] = d2;
          pairTime[q] = t;
        }
        q++;
      }
    }

    if (k % coarseStride === 0) {
      const ci = k / coarseStride;
      profile[ci] = Math.sqrt(stepMinSq);
      if (stepMinSq < coarseBestSq) {
        coarseBestSq = stepMinSq;
        coarseTime = t;
        coarsePair = [pairI[stepMinPair], pairJ[stepMinPair]];
      }
    }

    if (stepMinSq < fineBestSq) {
      fineBestSq = stepMinSq;
      fineBestPair = stepMinPair;
      fineBestT = t;
    }
  }

  /* ---- refine every pair that came within 250 km at any 10 s sample ----
     A 10 s sample can miss the true minimum by at most about half the
     relative motion in 10 s, so any dangerous pass is guaranteed to enter
     this list. Distant minima keep the sampled value and time. */
  const candidates = [];
  for (let p = 0; p < pairCount; p++) {
    if (pairMinSq[p] < 250 * 250) {
      candidates.push(p);
    }
  }

  let bestSq = Infinity;
  let bestT = fineBestT;
  let bestPair = fineBestPair;
  let refined = false;

  for (const p of candidates) {
    const r = refineClosest(sats[pairI[p]], sats[pairJ[p]], pairTime[p], FINE_STEP * 1.5);
    if (r.d2 < bestSq) {
      bestSq = r.d2;
      bestT = r.t;
      bestPair = p;
      refined = true;
    }
  }

  // Ensure a numeric result even if the candidate list somehow stayed empty.
  if (!isFinite(bestSq)) bestSq = fineBestSq;

  const minSep = Math.sqrt(Math.max(0, bestSq));

  return {
    sats,
    pair: [pairI[bestPair], pairJ[bestPair]],
    minSep,
    minTime: bestT,
    status: statusFor(minSep),
    profile,
    epochs: coarseSteps + 1,
    fineSamples: fineSteps + 1,
    pairCount,
    refined,
    coarseMin: Math.sqrt(coarseBestSq),
    coarseTime,
    coarsePair,
    durationMs: performance.now() - started
  };
}

/* =========================================================================
   FORMATTING
   ========================================================================= */
function fmtKm(d) {
  if (!isFinite(d)) return "\u2014";
  if (d < 10) return d.toFixed(2) + " km";
  if (d < 100) return d.toFixed(1) + " km";
  return Math.round(d).toLocaleString("en-US") + " km";
}

function fmtDeg(v, digits = 1) {
  return v.toFixed(digits) + "\u00b0";
}

function fmtClock(t) {
  const day = Math.floor(t / DAY);
  t = mod(t, DAY);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return "T+ " + (day > 0 ? day + "d " : "") +
         String(h).padStart(2, "0") + ":" +
         String(m).padStart(2, "0") + ":" +
         String(s).padStart(2, "0");
}

function fmtClockShort(t) {
  const day = Math.floor(t / DAY);
  t = mod(t, DAY);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return "T+" + (day > 0 ? day + "d " : "") +
    String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

/** Signed RAAN drift in degrees per day from a rad/s rate. */
function fmtDrift(radPerSec) {
  const d = radPerSec * R2D * DAY;
  if (Math.abs(d) < 0.005) return "0.00\u00b0/day";
  return (d > 0 ? "+" : "\u2212") + Math.abs(d).toFixed(2) + "\u00b0/day";
}

function closestPair(analysis) {
  if (!analysis || !analysis.pair) return { a: null, b: null };
  return {
    a: analysis.sats[analysis.pair[0]],
    b: analysis.sats[analysis.pair[1]]
  };
}

/* =========================================================================
   EDUCATIONAL FEEDBACK
   ========================================================================= */

/** Smallest mean-anomaly gap between any two satellites in two planes. */
function minPhaseGap(planeA, planeB) {
  let min = 360;
  for (const sa of planeA.sats) {
    for (const sb of planeB.sats) {
      const d = angleDiff(sa.m0 * R2D, sb.m0 * R2D);
      if (d < min) min = d;
    }
  }
  return min;
}

/** Explain the geometry between the new plane and the closest existing plane. */
function geometryNote(newPlane, oldPlane) {
  if (newPlane.id === oldPlane.id) {
    if (newPlane.count === 1) {
      return "The closest pair is inside <b>" + newPlane.label + "</b>. With only one " +
        "satellite in the plane, there is no intra-plane neighbour; the minimum is set " +
        "by a crossing with another plane.";
    }
    const chord = 2 * A_SMA * Math.sin(Math.PI / newPlane.count);
    return "Both satellites belong to <b>" + newPlane.label + "</b>. With " +
      newPlane.count + " evenly spaced satellites in one circular ring, neighbours " +
      "are about <b>" + fmtKm(chord) + "</b> apart. Intra-plane spacing is fixed by " +
      "the satellite count and does not change with time.";
  }

  const di = Math.abs(newPlane.inc - oldPlane.inc);
  const dro = angleDiff(newPlane.raan, oldPlane.raan);
  const bothEquatorial = newPlane.inc < 0.6 && oldPlane.inc < 0.6;
  const coplanar = (di < 0.75 && dro < 0.75) || bothEquatorial;

  const parts = [];
  parts.push("Against <b>" + oldPlane.label + "</b> (i " + fmtDeg(oldPlane.inc) +
    ", &Omega; " + fmtDeg(oldPlane.raan) + "), the new plane differs by <b>&Delta;i " +
    fmtDeg(di) + "</b> and <b>&Delta;&Omega; " + fmtDeg(dro) + "</b>.");

  if (coplanar) {
    if (bothEquatorial && dro > 0.75) {
      parts.push("Both planes are equatorial: at <b>i = 0&deg;</b> RAAN is degenerate, " +
        "so every equatorial plane is the same ring. A change in &Omega; is just a " +
        "phase shift along that ring; separation is controlled by where the satellites " +
        "sit in phase.");
    } else {
      const gap = minPhaseGap(newPlane, oldPlane);
      const chord = 2 * A_SMA * Math.sin(gap * D2R / 2);
      parts.push("The planes are effectively coplanar, so both constellations share " +
        "the same ring. Separation is controlled entirely by phase: the nearest pair " +
        "is <b>" + fmtDeg(gap) + "</b> apart in mean anomaly, a chord of <b>" +
        fmtKm(chord) + "</b>.");
    }
  } else if (di < 10 && dro < 30) {
    parts.push("Similar inclinations and RAAN values make the orbital planes cross at a " +
      "<b>shallow angle</b>. Near the crossing point the satellites move almost parallel, " +
      "so they can remain close for a long time.");
  } else if (dro < 10 && di >= 10) {
    parts.push("The planes share nearly the same line of nodes (&Delta;&Omega; " +
      fmtDeg(dro) + ") but differ in inclination by <b>" + fmtDeg(di) + "</b>. " +
      "Their orbits cross at the ascending and descending nodes; a close pass occurs " +
      "when both satellites reach a node together.");
  } else if (di < 10) {
    parts.push("The inclinations are close (&Delta;i " + fmtDeg(di) + "), so both " +
      "planes reach the same latitudes. The RAAN separation of " + fmtDeg(dro) +
      " rotates the two crossing points.");
  } else {
    parts.push("The two orbital planes intersect along two lines. A close pass occurs " +
      "where the circular paths cross and both satellites arrive at nearly the same time.");
  }

  if (newPlane.inc > 85 || oldPlane.inc > 85) {
    parts.push(newPlane.inc > 85 && oldPlane.inc > 85
      ? "Both are near-polar: every high-inclination plane funnels through the polar " +
        "regions, so a RAAN difference does not prevent close passes near the poles."
      : "One plane is near-polar: high-inclination orbits funnel through the polar " +
        "regions, where crossings are harder to separate with RAAN alone.");
  }

  // J2 nodal precession scales with cos(i), so planes at different
  // inclinations shear apart over the 24 hour screen.
  if (di > 0.5) {
    parts.push("J2 nodal precession is inclination-dependent: <b>" + newPlane.label +
      "</b> drifts <b>" + fmtDrift(newPlane.raanDot) + "</b> while <b>" +
      oldPlane.label + "</b> drifts <b>" + fmtDrift(oldPlane.raanDot) +
      "</b>, so &Delta;&Omega; changes across the day and the crossing points move.");
  } else {
    parts.push("Both planes have nearly the same inclination, so J2 precesses them at " +
      "almost the same rate; their relative geometry stays close to fixed over the day.");
  }

  if (newPlane.count > 1) {
    parts.push("Within the new plane, <b>&phi; = " + fmtDeg(newPlane.phase, 0) +
      "</b> places the first satellite at that mean anomaly; the remaining " +
      (newPlane.count - 1) + " are spaced " + fmtDeg(360 / newPlane.count, 1) + " apart.");
  }

  return parts.join(" ");
}

/**
 * Build the HTML explanation displayed after every deployment attempt.
 * The explanation is generated from the same propagation data that decides
 * the outcome, never from scripted rules.
 */
function buildFeedback(plane, analysis, prevAnalysis) {
  if (!analysis || !plane) return "";

  const { a, b } = closestPair(analysis);
  const accepted = analysis.status === "SAFE";
  const total = analysis.sats.length;
  const chunks = [];

  /* ---- headline ---- */
  if (accepted) {
    chunks.push("<b class=\"good\">Deployment accepted.</b> The expanded constellation " +
      "satisfies the 10 km rule: the closest pair stays <b>" + fmtKm(analysis.minSep) +
      "</b> apart over the full 24 hour screen.");
  } else if (analysis.status === "COLLISION") {
    chunks.push("<b class=\"bad\">Collision predicted &mdash; deployment rejected.</b> " +
      "The proposed plane would put two satellites within <b>" + fmtKm(analysis.minSep) +
      "</b> of each other. No random event is involved: the geometry itself brings them " +
      "to the same place at the same time.");
  } else {
    chunks.push("<b class=\"warn\">Unsafe conjunction &mdash; deployment rejected.</b> " +
      "The proposed plane would reduce the closest approach to <b>" + fmtKm(analysis.minSep) +
      "</b>, below the 10 km safety limit.");
  }

  if (a && b) {
    chunks.push("<span class=\"hintline\">Closest pair: <b>" + a.label + "</b> and <b>" +
      b.label + "</b> at <b>" + fmtClock(analysis.minTime) + "</b>.</span>");
  }

  /* ---- which geometry created the minimum ---- */
  if (a && b && accepted) {
    const newInPair = a.plane.id === plane.id ? a : (b.plane.id === plane.id ? b : null);
    const otherInPair = a.plane.id === plane.id ? b : (b.plane.id === plane.id ? a : null);

    if (newInPair && otherInPair) {
      chunks.push(geometryNote(newInPair.plane, otherInPair.plane));
    } else if (a.plane.id === plane.id && b.plane.id === plane.id) {
      chunks.push(geometryNote(plane, plane));
    } else {
      chunks.push("The tightest pass in the expanded constellation is still between " +
        "existing planes <b>" + a.plane.label + "</b> and <b>" + b.plane.label +
        "</b>. The new plane is farther away than this baseline, so it did not create " +
        "the limiting geometry.");
    }

    if (prevAnalysis && isFinite(prevAnalysis.minSep) && isFinite(analysis.minSep)) {
      const prev = prevAnalysis.minSep;
      if (Math.abs(prev - analysis.minSep) < 0.05) {
        chunks.push("Constellation-wide clearance is <b>unchanged at " + fmtKm(prev) +
          "</b>; the new plane is safely outside the existing minimum.");
      } else {
        chunks.push("Constellation-wide clearance moved from <b>" + fmtKm(prev) +
          "</b> to <b>" + fmtKm(analysis.minSep) + "</b>. The new plane's inclination " +
          "and RAAN decide <i>where</i> it crosses the existing rings; its phase offset " +
          "decides <i>when</i> a satellite is at that crossing.");
      }
    }

    if (analysis.minSep < 50) {
      chunks.push("<span class=\"hintline\">This deployment is legal but tight: only " +
        fmtKm(analysis.minSep - SAFE_KM) + " above the 10 km limit. A small phase change " +
        "could make the next addition unsafe.</span>");
    }
  }

  /* ---- rejection: explain and offer concrete controls ---- */
  if (!accepted && a && b) {
    const newInPair = a.plane.id === plane.id ? a : (b.plane.id === plane.id ? b : null);
    const otherInPair = a.plane.id === plane.id ? b : (b.plane.id === plane.id ? a : null);

    if (newInPair && otherInPair) {
      chunks.push(geometryNote(newInPair.plane, otherInPair.plane));
    } else if (a.plane.id === plane.id && b.plane.id === plane.id) {
      chunks.push(geometryNote(plane, plane));
    }

    const degKm = Math.round(A_SMA * D2R);
    chunks.push("<span class=\"hintline\">Satellites must not occupy nearly the same " +
      "location at the same time. Try a different <b>RAAN</b> to move the intersection " +
      "line, or a different <b>phase offset</b> to change arrival time. At 550 km, one " +
      "degree of phase is about " + degKm + " km along the orbit. J2 also precesses each " +
      "plane at a rate set by its inclination, so a pair that is separated at epoch can " +
      "still converge later in the 24 hour screen.</span>");
  }

  /* ---- metric chips ---- */
  const chips = [];
  chips.push("<span class=\"chip\">min " + fmtKm(analysis.minSep) + "</span>");
  chips.push("<span class=\"chip\">" + plane.count + " sats</span>");
  chips.push("<span class=\"chip\">i " + fmtDeg(plane.inc) + "</span>");
  chips.push("<span class=\"chip\">&Omega; " + fmtDeg(plane.raan, 0) + "</span>");
  chips.push("<span class=\"chip\">&phi; " + fmtDeg(plane.phase, 0) + "</span>");
  chips.push("<span class=\"chip\">J2 &Omega;&#775; " + fmtDrift(plane.raanDot) + "</span>");

  if (a && b && a.plane.id !== b.plane.id) {
    const di = Math.abs(a.plane.inc - b.plane.inc);
    const dro = angleDiff(a.plane.raan, b.plane.raan);
    chips.push("<span class=\"chip\">&Delta;i " + fmtDeg(di) + "</span>");
    chips.push("<span class=\"chip\">&Delta;&Omega; " + fmtDeg(dro) + "</span>");
  }
  if (!accepted) {
    chips.push("<span class=\"chip bad\">rejected</span>");
  } else {
    chips.push("<span class=\"chip good\">" + total + " total</span>");
  }

  chunks.push("<span class=\"chips\">" + chips.join("") + "</span>");
  return chunks.join("");
}

/** Explanation for the initial safe constellation. */
function buildSeedFeedback(analysis) {
  const plane = state.planes[0];
  const chord = plane.count > 1
    ? 2 * A_SMA * Math.sin(Math.PI / plane.count)
    : Infinity;

  return "<b class=\"good\">Seed constellation online.</b> " + plane.count +
    " satellites share one <b>" + fmtDeg(plane.inc, 0) + "</b> inclined plane. " +
    "Neighbouring satellites are <b>" + fmtKm(chord) + "</b> apart, so the intra-plane " +
    "baseline is safe. This plane's node drifts <b>" + fmtDrift(plane.raanDot) +
    "</b> under J2. Deploy a second plane and watch how RAAN moves the crossing " +
    "points while phase changes the time a satellite arrives there." +
    "<span class=\"chips\">" +
    "<span class=\"chip good\">" + analysis.sats.length + " sats</span>" +
    "<span class=\"chip\">min " + fmtKm(analysis.minSep) + "</span>" +
    "<span class=\"chip\">24 h &middot; 10 s J2 propagation</span>" +
    "</span>";
}

/** Explanation shown when the design capacity would be exceeded. */
function buildCapacityFeedback(params, total) {
  return "<b class=\"warn\">Design capacity reached.</b> Another plane of " +
    params.count + " satellites would take the constellation to " +
    (total + params.count) + " satellites, above the " + MAX_SATS +
    "-satellite limit. Reduce <b>satellites per plane</b>, or reset the mission to " +
    "explore a different architecture. The existing constellation remains safe and " +
    "fully analysed.";
}

/* =========================================================================
   DOM REFERENCES
   ========================================================================= */
const $ = id => document.getElementById(id);

const ui = {
  scene: $("scene"),
  clock: $("clock"),
  speedLabel: $("speedLabel"),
  btnPause: $("btnPause"),
  btnUI: $("btnUI"),
  left: $("left"),
  right: $("right"),

  score: $("score"),
  satCount: $("satCount"),
  satCap: $("satCap"),
  planeCount: $("planeCount"),
  committedMin: $("committedMin"),
  liveMin: $("liveMin"),

  inc: $("inc"),
  raan: $("raan"),
  count: $("count"),
  phase: $("phase"),
  incOut: $("incOut"),
  raanOut: $("raanOut"),
  countOut: $("countOut"),
  phaseOut: $("phaseOut"),
  previewTag: $("previewTag"),
  deploy: $("deploy"),
  deploySub: $("deploySub"),
  capacityNote: $("capacityNote"),

  analysisMode: $("analysisMode"),
  statusCard: $("statusCard"),
  statusWord: $("statusWord"),
  statusSep: $("statusSep"),
  statusExplain: $("statusExplain"),
  aMin: $("aMin"),
  aTime: $("aTime"),
  aPair: $("aPair"),
  aEpochs: $("aEpochs"),
  profile: $("profile"),
  profileCursor: $("profileCursor"),
  feedback: $("feedback"),
  btnViewClose: $("btnViewClose"),

  log: $("log"),
  logCount: $("logCount"),
  toast: $("toast"),
  tooltip: $("tooltip"),
  hint: $("hint"),
  liveTag: $("liveTag"),
  btnReset: $("btnReset"),
  btnResetView: $("btnResetView")
};

/* =========================================================================
   CONTROL INPUTS
   ========================================================================= */
function readParams() {
  return {
    inc: +ui.inc.value,
    raan: +ui.raan.value,
    count: +ui.count.value,
    phase: +ui.phase.value
  };
}

function updateSliderFill(input) {
  const min = +input.min;
  const max = +input.max;
  const val = +input.value;
  input.style.setProperty("--fill", ((val - min) / (max - min) * 100).toFixed(2) + "%");
}

function syncControlUI() {
  ui.incOut.textContent = (+ui.inc.value).toFixed(1) + "\u00b0";
  ui.raanOut.textContent = (+ui.raan.value).toFixed(0) + "\u00b0";
  ui.countOut.textContent = String(+ui.count.value);
  ui.phaseOut.textContent = (+ui.phase.value).toFixed(0) + "\u00b0";
  updateSliderFill(ui.inc);
  updateSliderFill(ui.raan);
  updateSliderFill(ui.count);
  updateSliderFill(ui.phase);
}

function onControlInput() {
  syncControlUI();
  state.previewArmed = true;
  state.focus = null;
  updateDeployButton();
  updatePreviewTag();
  if (state.previewTimer) clearTimeout(state.previewTimer);
  ui.previewTag.textContent = "CHECKING\u2026";
  state.previewTimer = setTimeout(runPreview, 200);
}

function schedulePreviewSoon() {
  if (state.previewTimer) clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(runPreview, 200);
}

/* =========================================================================
   PREVIEW / DEPLOYMENT
   ========================================================================= */
function currentViewAnalysis() {
  if (state.preview && !state.preview.overflow && state.preview.analysis) {
    return state.preview.analysis;
  }
  return state.analysis;
}

function runPreview() {
  state.previewTimer = null;
  if (!state.previewArmed) return;

  const params = readParams();
  const total = state.sats.length;

  if (total + params.count > MAX_SATS) {
    state.preview = {
      params,
      plane: null,
      analysis: null,
      feedback: buildCapacityFeedback(params, total),
      overflow: true
    };
    updatePreviewTag();
    updateDeployButton();
    updateAnalysisPanel();
    return;
  }

  const plane = createPlane(params, state.nextPlaneId);
  const analysis = analyzeConstellation(state.sats.concat(plane.sats));
  const feedback = buildFeedback(plane, analysis, state.analysis);

  state.preview = { params, plane, analysis, feedback, overflow: false };
  updatePreviewTag();
  updateDeployButton();
  updateAnalysisPanel();
}

function updatePreviewTag() {
  const params = readParams();
  if (state.sats.length + params.count > MAX_SATS) {
    ui.previewTag.textContent = "CAPACITY";
    return;
  }
  ui.previewTag.textContent = state.previewArmed
    ? "PREVIEW +" + params.count
    : "NEW PLANE";
}

function deploy() {
  if (state.previewTimer) {
    clearTimeout(state.previewTimer);
    state.previewTimer = null;
  }

  const params = readParams();
  const totalBefore = state.sats.length;

  if (totalBefore + params.count > MAX_SATS) {
    state.preview = {
      params,
      plane: null,
      analysis: null,
      feedback: buildCapacityFeedback(params, totalBefore),
      overflow: true
    };
    state.previewArmed = true;
    updatePreviewTag();
    updateDeployButton();
    updateAnalysisPanel();
    toast("Capacity exceeded \u2014 deployment rejected", "bad");
    addLog("warn", "CAPACITY",
      "A +" + params.count + " plane would exceed " + MAX_SATS + " satellites.");
    return;
  }

  const plane = createPlane(params, state.nextPlaneId);
  const candidateSats = state.sats.concat(plane.sats);
  const analysis = analyzeConstellation(candidateSats);
  const feedback = buildFeedback(plane, analysis, state.analysis);

  if (analysis.status === "SAFE") {
    /* ---- commit the plane ---- */
    state.nextPlaneId++;
    state.planes.push(plane);
    state.sats = candidateSats;
    state.analysis = analysis;
    state.lastFeedback = feedback;
    state.preview = null;
    state.previewArmed = false;
    state.focus = null;

    state.score += PLANE_BONUS + plane.count * SAT_POINTS;
    checkMilestones(totalBefore, state.sats.length);

    addLog("ok", "DEPLOY " + plane.label,
      "+" + plane.count + " sats \u00b7 i " + fmtDeg(plane.inc) +
      " \u00b7 \u03a9 " + fmtDeg(plane.raan, 0) +
      " \u00b7 \u03c6 " + fmtDeg(plane.phase, 0) +
      " \u00b7 closest " + fmtKm(analysis.minSep) +
      " (" + analysis.status + ")");

    toast("Deployed " + plane.label + " \u2014 closest approach " + fmtKm(analysis.minSep), "ok");
    ui.deploy.classList.add("flash");
    setTimeout(() => ui.deploy.classList.remove("flash"), 600);
  } else {
    /* ---- reject the plane, but keep it visible as a ghost ---- */
    state.preview = { params, plane, analysis, feedback, overflow: false };
    state.previewArmed = true;
    state.focus = null;

    addLog(analysis.status === "COLLISION" ? "bad" : "warn",
      "REJECTED " + plane.label,
      "+" + plane.count + " sats \u00b7 i " + fmtDeg(plane.inc) +
      " \u00b7 \u03a9 " + fmtDeg(plane.raan, 0) +
      " \u00b7 \u03c6 " + fmtDeg(plane.phase, 0) +
      " \u00b7 closest " + fmtKm(analysis.minSep) +
      " \u00b7 " + analysis.status);

    toast(analysis.status + " \u2014 closest approach " + fmtKm(analysis.minSep), "bad");
  }

  updateAllUI();
}

function checkMilestones(prevCount, newCount) {
  for (const m of MILESTONES) {
    if (!state.milestones.has(m.n) && prevCount < m.n && newCount >= m.n) {
      state.milestones.add(m.n);
      state.score += m.bonus;
      addLog("note", "MILESTONE",
        m.text + " \u00b7 +" + m.bonus.toLocaleString("en-US") + " bonus");
      toast("Milestone: " + m.text + " (+" + m.bonus + ")", "ok");
    }
  }
}

/* =========================================================================
   SEED / RESET
   ========================================================================= */
const SEED_PARAMS = { inc: 53, raan: 0, count: 4, phase: 0 };
const NEXT_PARAMS = { inc: 53, raan: 120, count: 6, phase: 0 };

function setControlValues(p) {
  ui.inc.value = String(p.inc);
  ui.raan.value = String(p.raan);
  ui.count.value = String(p.count);
  ui.phase.value = String(p.phase);
  syncControlUI();
}

function seedMission() {
  if (state.previewTimer) {
    clearTimeout(state.previewTimer);
    state.previewTimer = null;
  }
  state.planes = [];
  state.sats = [];
  state.nextPlaneId = 1;
  state.preview = null;
  state.previewArmed = false;
  state.focus = null;
  state.simTime = 0;
  state.score = 0;
  state.milestones.clear();
  state.liveMin = Infinity;
  state.livePair = null;
  state.screenSats = [];
  hideTooltip();

  const plane = createPlane(SEED_PARAMS, state.nextPlaneId++);
  state.planes.push(plane);
  state.sats = plane.sats.slice();

  const analysis = analyzeConstellation(state.sats);
  state.analysis = analysis;
  state.lastFeedback = buildSeedFeedback(analysis);
  state.score = PLANE_BONUS + plane.count * SAT_POINTS;

  setControlValues(NEXT_PARAMS);
  syncControlUI();

  addLog("ok", "SEED",
    "Plane P1 online \u00b7 " + plane.count + " sats \u00b7 i " +
    fmtDeg(plane.inc) + " \u00b7 \u03a9 " + fmtDeg(plane.raan, 0) +
    " \u00b7 \u03c6 " + fmtDeg(plane.phase, 0));
  addLog("note", "ANALYSIS",
    analysis.epochs + " epochs at 300 s \u00b7 " + analysis.pairCount +
    " pairs \u00b7 closest " + fmtKm(analysis.minSep));

  updateAllUI();
}

function resetMission() {
  state.resetArmed = false;
  if (state.resetTimer) clearTimeout(state.resetTimer);
  ui.btnReset.classList.remove("confirm");
  ui.btnReset.textContent = "Reset mission";
  ui.log.innerHTML = "";
  seedMission();
  setPaused(false);
  toast("Mission reset \u2014 new seed constellation deployed", "info");
}

/* =========================================================================
   UI UPDATES
   ========================================================================= */
function updateAllUI() {
  updateStats();
  updateDeployButton();
  updatePreviewTag();
  updateAnalysisPanel();
  updatePauseUI();
}

function updateStats() {
  ui.score.textContent = state.score.toLocaleString("en-US");
  ui.satCount.textContent = String(state.sats.length);
  ui.satCap.textContent = "/ " + MAX_SATS;
  ui.planeCount.textContent = String(state.planes.length);

  const a = state.analysis;
  if (a) {
    ui.committedMin.textContent = fmtKm(a.minSep);
    ui.committedMin.style.color = a.status === "SAFE" ? "var(--safe)" :
      (a.status === "COLLISION" ? "var(--danger)" : "var(--warn)");
  } else {
    ui.committedMin.textContent = "\u2014";
  }
}

function updateDeployButton() {
  const params = readParams();
  const total = state.sats.length;
  const newTotal = total + params.count;
  const overflow = newTotal > MAX_SATS;

  ui.deploy.disabled = overflow;
  ui.deploySub.textContent = overflow
    ? total + " + " + params.count + " exceeds " + MAX_SATS
    : "+" + params.count + " satellites \u00b7 " + newTotal + " total";

  if (overflow) {
    ui.capacityNote.innerHTML = "<b style=\"color:var(--warn)\">Capacity exceeded.</b> " +
      "Reduce satellites per plane or reset the mission.";
  } else {
    const left = MAX_SATS - newTotal;
    ui.capacityNote.textContent = left + " satellites of design capacity remaining. " +
      "Unsafe planes are never committed.";
  }
}

function setStatusCard(kind, word, sep, explain) {
  ui.statusCard.className = "status-card " + kind;
  ui.statusWord.textContent = word;
  ui.statusSep.textContent = sep;
  ui.statusExplain.textContent = explain;
}

function updateAnalysisPanel() {
  const pv = state.preview;
  const overflow = !!(pv && pv.overflow);
  const analysis = overflow ? null : (pv && pv.analysis ? pv.analysis : state.analysis);
  const feedback = overflow ? pv.feedback : (pv ? pv.feedback : state.lastFeedback);

  if (overflow) {
    ui.analysisMode.textContent = "CAPACITY";
    ui.analysisMode.style.color = "var(--warn)";
    setStatusCard("warn", "CAPACITY", state.sats.length + " / " + MAX_SATS,
      "The proposed plane would exceed the design capacity. The current constellation " +
      "is unchanged and remains safe.");
    ui.aMin.textContent = "\u2014";
    ui.aTime.textContent = "\u2014";
    ui.aPair.textContent = "\u2014";
    ui.aEpochs.textContent = "\u2014";
    ui.btnViewClose.disabled = true;
  } else if (analysis) {
    const proposed = !!pv;
    ui.analysisMode.textContent = proposed ? "PROPOSED +" + pv.params.count : "CURRENT";
    ui.analysisMode.style.color = proposed ? "var(--accent-2)" : "var(--accent)";

    const kind = analysis.status === "SAFE" ? "safe" :
      (analysis.status === "COLLISION" ? "danger" : "warn");
    const word = analysis.status === "DANGEROUS" ? "DANGER" : analysis.status;

    let explain;
    if (analysis.status === "SAFE") {
      explain = (proposed ? "Proposed plane: all " : "All ") + analysis.sats.length +
        " satellites stay at least " + fmtKm(analysis.minSep) +
        " apart over the full 24 hour screen.";
    } else if (analysis.status === "COLLISION") {
      explain = (proposed ? "Proposed plane: a pair" : "A pair") + " reaches " +
        fmtKm(analysis.minSep) + ", below the 1 km collision threshold.";
    } else {
      explain = (proposed ? "Proposed plane: a pair would close to " : "A pair closes to ") +
        fmtKm(analysis.minSep) + ", below the 10 km safety limit.";
    }

    setStatusCard(kind, word, fmtKm(analysis.minSep), explain);

    const { a, b } = closestPair(analysis);
    ui.aMin.textContent = fmtKm(analysis.minSep);
    ui.aTime.textContent = a ? fmtClock(analysis.minTime) : "\u2014";
    ui.aPair.textContent = a ? a.label + " \u2194 " + b.label : "\u2014";
    ui.aEpochs.textContent = analysis.epochs + " \u00d7 300 s \u00b7 " +
      analysis.pairCount.toLocaleString("en-US") + " pairs";
    ui.aEpochs.title = "Full 24 h propagated at 10 s (" + analysis.fineSamples +
      " samples) with secular J2; the 300 s clearance profile is sampled from the " +
      "same pass and close candidates are refined continuously.";
    ui.btnViewClose.disabled = !analysis.pair;
  } else {
    ui.analysisMode.textContent = "CURRENT";
    setStatusCard("safe", "SAFE", "\u2014", "Awaiting constellation analysis.");
    ui.aMin.textContent = "\u2014";
    ui.aTime.textContent = "\u2014";
    ui.aPair.textContent = "\u2014";
    ui.aEpochs.textContent = "\u2014";
    ui.btnViewClose.disabled = true;
  }

  ui.feedback.innerHTML = feedback || "";
  drawProfile();
}

function updatePauseUI() {
  ui.btnPause.innerHTML = state.paused ? "&#9654;" : "&#10074;&#10074;";
  ui.btnPause.classList.toggle("active", state.paused);
  ui.btnPause.title = state.paused ? "Resume simulation" : "Pause simulation";
  ui.liveTag.textContent = state.paused ? "PAUSED" : "LIVE";
  ui.liveTag.style.color = state.paused ? "var(--accent-2)" : "var(--accent)";
}

/* =========================================================================
   LOG + TOAST
   ========================================================================= */
function addLog(kind, tag, message, time) {
  const t = time == null ? state.simTime : time;
  const entry = document.createElement("div");
  entry.className = "log-entry " + kind;
  entry.innerHTML =
    "<div class=\"log-top\"><b>" + fmtClockShort(t) + "</b><span>" + tag + "</span></div>" +
    "<div class=\"log-msg\">" + message + "</div>";

  ui.log.appendChild(entry);
  while (ui.log.children.length > 80) ui.log.removeChild(ui.log.firstChild);
  ui.log.scrollTop = ui.log.scrollHeight;
  ui.logCount.textContent = String(ui.log.children.length);
}

let toastTimer = null;
function toast(message, kind = "info") {
  ui.toast.textContent = message;
  ui.toast.className = "show " + kind;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.className = ""; }, 2600);
}

/* =========================================================================
   SIMULATION CONTROLS
   ========================================================================= */
function setPaused(paused) {
  state.paused = paused;
  if (!paused) state.focus = null;
  updatePauseUI();
}

function setSpeed(speed) {
  state.speed = speed;
  ui.speedLabel.textContent = speed + "\u00d7";
  document.querySelectorAll(".spd").forEach(b => {
    b.classList.toggle("active", +b.dataset.speed === speed);
  });
}

function viewClosestPass() {
  const analysis = currentViewAnalysis();
  if (!analysis || !analysis.pair) return;

  const { a, b } = closestPair(analysis);

  // Rotate the globe so the conjunction midpoint faces the camera. Without
  // this, a closest pass on the far side of Earth would be hidden at the very
  // moment the player asked to inspect it.
  satPos(a, analysis.minTime, _pa);
  satPos(b, analysis.minTime, _pb);
  const mx = (_pa[0] + _pb[0]) / 2;
  const my = (_pa[1] + _pb[1]) / 2;
  const mz = (_pa[2] + _pb[2]) / 2;
  const len = Math.hypot(mx, my, mz);
  if (len > 1) {
    state.cam.yaw = Math.atan2(my, mx);
    state.cam.pitch = clamp(Math.asin(mz / len), -1.42, 1.42);
  }

  state.simTime = analysis.minTime;
  state.paused = true;
  state.focus = { sats: [a, b], t: analysis.minTime };
  updatePauseUI();
  updateHUD(true);
  toast("Closest pass loaded: " + fmtClock(analysis.minTime) +
    " \u00b7 " + fmtKm(analysis.minSep), "info");
}

/* =========================================================================
   EVENT BINDING
   ========================================================================= */
function bindEvents() {
  [ui.inc, ui.raan, ui.count, ui.phase].forEach(input => {
    input.addEventListener("input", onControlInput);
  });

  ui.deploy.addEventListener("click", deploy);
  ui.btnViewClose.addEventListener("click", viewClosestPass);

  ui.btnPause.addEventListener("click", () => setPaused(!state.paused));

  document.querySelectorAll(".spd").forEach(btn => {
    btn.addEventListener("click", () => setSpeed(+btn.dataset.speed));
  });

  ui.btnResetView.addEventListener("click", () => {
    state.cam.yaw = 0.58;
    state.cam.pitch = 0.36;
    state.cam.zoom = 1;
    toast("Camera reset", "info");
  });

  ui.btnReset.addEventListener("click", () => {
    if (!state.resetArmed) {
      state.resetArmed = true;
      ui.btnReset.classList.add("confirm");
      ui.btnReset.textContent = "Confirm reset?";
      state.resetTimer = setTimeout(() => {
        state.resetArmed = false;
        ui.btnReset.classList.remove("confirm");
        ui.btnReset.textContent = "Reset mission";
      }, 3200);
    } else {
      resetMission();
    }
  });

  ui.btnUI.addEventListener("click", () => {
    // On phone-width screens the panels are full overlays. Cycle through
    // deployment, analysis, and closed so one button remains a complete
    // navigation control instead of stacking both panels on top of each other.
    if (window.matchMedia("(max-width: 860px)").matches) {
      const leftOpen = ui.left.classList.contains("open");
      const rightOpen = ui.right.classList.contains("open");
      if (!leftOpen && !rightOpen) {
        ui.left.classList.add("open");
      } else if (leftOpen) {
        ui.left.classList.remove("open");
        ui.right.classList.add("open");
      } else {
        ui.right.classList.remove("open");
      }
    } else {
      ui.left.classList.toggle("open");
      ui.right.classList.toggle("open");
    }
  });

  window.addEventListener("keydown", e => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "BUTTON" || tag === "TEXTAREA") return;
    if (e.code === "Space") {
      e.preventDefault();
      setPaused(!state.paused);
    }
  });

  // Profile scrubbing
  const profile = ui.profile;
  let scrubbing = false;

  function scrubFromEvent(e) {
    const rect = profile.getBoundingClientRect();
    const padL = 4, padR = 30;
    const x = clamp(e.clientX - rect.left, padL, rect.width - padR);
    const frac = (x - padL) / Math.max(1, rect.width - padL - padR);
    state.simTime = clamp(frac, 0, 1) * DAY;
    state.paused = true;
    state.focus = null;
    updatePauseUI();
    updateHUD(true);
  }

  profile.addEventListener("pointerdown", e => {
    scrubbing = true;
    profile.setPointerCapture(e.pointerId);
    scrubFromEvent(e);
  });
  profile.addEventListener("pointermove", e => {
    if (scrubbing) scrubFromEvent(e);
  });
  profile.addEventListener("pointerup", e => {
    scrubbing = false;
    if (profile.hasPointerCapture(e.pointerId)) profile.releasePointerCapture(e.pointerId);
  });
}

/* =========================================================================
   CLEARANCE PROFILE (small canvas)
   ========================================================================= */
function drawProfile() {
  const canvas = ui.profile;
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 20) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#070d18";
  ctx.fillRect(0, 0, w, h);

  const padL = 4, padR = 30, padT = 8, padB = 13;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const logMin = -0.3;                 // 0.5 km
  const logMax = Math.log10(30000);    // 30,000 km
  const xFor = t => padL + plotW * clamp(t / DAY, 0, 1);
  const yFor = d => {
    const l = Math.log10(Math.max(0.5, isFinite(d) ? d : 30000));
    return padT + plotH * (1 - clamp((l - logMin) / (logMax - logMin), 0, 1));
  };

  /* danger bands: 1-10 km amber, below 1 km red */
  ctx.fillStyle = "rgba(255, 192, 77, 0.055)";
  ctx.fillRect(padL, yFor(10), plotW, yFor(1) - yFor(10));
  ctx.fillStyle = "rgba(255, 94, 114, 0.07)";
  ctx.fillRect(padL, yFor(1), plotW, h - padB - yFor(1));

  /* grid + labels */
  const grid = [1, 10, 100, 1000, 10000];
  ctx.font = "8px " + (getComputedStyle(document.body).fontFamily || "monospace");
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const g of grid) {
    const y = yFor(g);
    ctx.strokeStyle = (g === 1 || g === 10) ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.045)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();

    ctx.fillStyle = (g === 1) ? "rgba(255,94,114,0.75)" :
      (g === 10 ? "rgba(255,192,77,0.7)" : "rgba(120,140,170,0.55)");
    const label = g >= 1000 ? (g / 1000) + "k" : String(g);
    ctx.fillText(label, padL + plotW + 4, y);
  }

  const analysis = currentViewAnalysis();
  if (!analysis || !analysis.profile || !isFinite(analysis.minSep)) {
    ctx.fillStyle = "#4f5f7c";
    ctx.textAlign = "center";
    ctx.fillText("awaiting analysis", padL + plotW / 2, padT + plotH / 2);
    return;
  }

  const color = analysis.status === "SAFE" ? "#45e6a0" :
    (analysis.status === "COLLISION" ? "#ff5e72" : "#ffc04d");
  const profile = analysis.profile;

  /* filled area under the curve */
  ctx.beginPath();
  ctx.moveTo(xFor(0), h - padB);
  for (let k = 0; k < profile.length; k++) {
    const t = (k / (profile.length - 1)) * DAY;
    ctx.lineTo(xFor(t), yFor(profile[k]));
  }
  ctx.lineTo(xFor(DAY), h - padB);
  ctx.closePath();
  ctx.globalAlpha = 0.11;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;

  /* trace */
  ctx.beginPath();
  for (let k = 0; k < profile.length; k++) {
    const t = (k / (profile.length - 1)) * DAY;
    const x = xFor(t);
    const y = yFor(profile[k]);
    if (k === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.3;
  ctx.lineJoin = "round";
  ctx.stroke();

  /* closest approach marker */
  const mx = xFor(analysis.minTime);
  const my = yFor(analysis.minSep);
  ctx.beginPath();
  ctx.arc(mx, my, 3, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "#04121a";
  ctx.lineWidth = 1;
  ctx.stroke();

  /* current simulation cursor (the profile covers the first 24 h) */
  const px = xFor(mod(state.simTime, DAY));
  ctx.save();
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.40)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, padT);
  ctx.lineTo(px, h - padB);
  ctx.stroke();
  ctx.restore();
}

/* =========================================================================
   HUD / LIVE TELEMETRY
   ========================================================================= */
function computeLiveMin() {
  const sats = state.sats;
  if (sats.length < 2) return { d: Infinity, pair: null };

  const n = sats.length;
  const pos = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    satPos(sats[i], state.simTime, _pa);
    pos[i * 3] = _pa[0];
    pos[i * 3 + 1] = _pa[1];
    pos[i * 3 + 2] = _pa[2];
  }

  let best = Infinity;
  let bi = 0, bj = 1;
  for (let i = 0; i < n; i++) {
    const ix = i * 3;
    for (let j = i + 1; j < n; j++) {
      const jx = j * 3;
      const dx = pos[ix] - pos[jx];
      const dy = pos[ix + 1] - pos[jx + 1];
      const dz = pos[ix + 2] - pos[jx + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) {
        best = d2;
        bi = i;
        bj = j;
      }
    }
  }
  return { d: Math.sqrt(best), pair: [sats[bi], sats[bj]] };
}

function updateHUD(force) {
  const now = performance.now();
  if (!force && now - state.lastHudUpdate < 100) return;
  state.lastHudUpdate = now;

  ui.clock.textContent = fmtClock(state.simTime);
  const live = computeLiveMin();
  state.liveMin = live.d;
  state.livePair = live.pair;
  if (ui.liveMin) {
    ui.liveMin.textContent = fmtKm(live.d);
    ui.liveMin.style.color = live.d < COLLISION_KM ? "var(--danger)" :
      (live.d < SAFE_KM ? "var(--warn)" : "var(--txt)");
  }
  ui.profileCursor.textContent = fmtClockShort(state.simTime);
  drawProfile();
}

/* =========================================================================
   CANVAS RENDERING
   ========================================================================= */
const TAU = Math.PI * 2;
let sceneDpr = 1;
let sceneW = 0;
let sceneH = 0;

function fitScene() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.floor(window.innerWidth);
  const h = Math.floor(window.innerHeight);
  if (ui.scene.width !== Math.round(w * dpr) || ui.scene.height !== Math.round(h * dpr)) {
    ui.scene.width = Math.round(w * dpr);
    ui.scene.height = Math.round(h * dpr);
  }
  sceneDpr = dpr;
  sceneW = w;
  sceneH = h;
}

/* deterministic starfield */
function createStars(count) {
  const stars = [];
  let seed = 0x2f6e2b1;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const z = rnd() * 2 - 1;
    const a = rnd() * TAU;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    stars.push({
      x: r * Math.cos(a),
      y: r * Math.sin(a),
      z,
      b: 0.22 + rnd() * 0.78,
      tw: rnd() * TAU,
      size: rnd() < 0.13 ? 1.7 : 1
    });
  }
  return stars;
}
const STARS = createStars(340);

function cameraBasis() {
  const yaw = state.cam.yaw;
  const pitch = state.cam.pitch;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return {
    // unit vector from Earth's centre toward the viewer
    ex: cp * cy, ey: cp * sy, ez: sp,
    // screen-right
    rx: -sy, ry: cy, rz: 0,
    // screen-up
    ux: -sp * cy, uy: -sp * sy, uz: cp
  };
}

/* Earth-fixed lat/lon -> ECI at the current simulation time. */
function earthPoint(latDeg, lonDeg, out) {
  const theta = WE * state.simTime;
  const la = latDeg * D2R;
  const lo = lonDeg * D2R + theta;
  const cl = Math.cos(la);
  out[0] = R_E * cl * Math.cos(lo);
  out[1] = R_E * cl * Math.sin(lo);
  out[2] = R_E * Math.sin(la);
  return out;
}

function statusColor(status) {
  return status === "COLLISION" ? "#ff5e72" :
    (status === "DANGEROUS" ? "#ffc04d" : "#45e6a0");
}

function renderScene() {
  fitScene();
  const ctx = ui.scene.getContext("2d");
  ctx.setTransform(sceneDpr, 0, 0, sceneDpr, 0, 0);

  const W = sceneW;
  const H = sceneH;
  const now = performance.now();
  const cam = cameraBasis();
  const cx = W * 0.5;
  const cy = H * 0.5 + 8;
  const baseR = Math.min(W, H) * 0.285 * state.cam.zoom;
  const scale = baseR / R_E;

  const project = p => {
    const x = cx + (p[0] * cam.rx + p[1] * cam.ry + p[2] * cam.rz) * scale;
    const y = cy - (p[0] * cam.ux + p[1] * cam.uy + p[2] * cam.uz) * scale;
    const depth = p[0] * cam.ex + p[1] * cam.ey + p[2] * cam.ez;
    return { x, y, depth };
  };

  const occluded = p =>
    p.depth < 0 && Math.hypot(p.x - cx, p.y - cy) < baseR * 0.997;

  /* ---------- deep space ---------- */
  ctx.fillStyle = "#03060c";
  ctx.fillRect(0, 0, W, H);

  const bg = ctx.createRadialGradient(W * 0.68, H * 0.12, 0, W * 0.68, H * 0.12,
    Math.max(W, H) * 0.85);
  bg.addColorStop(0, "#0d1830");
  bg.addColorStop(0.45, "#070d1a");
  bg.addColorStop(1, "#03060c");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  /* ---------- stars ---------- */
  const starScale = Math.hypot(W, H) * 0.62;
  ctx.fillStyle = "#d5e8ff";
  for (const s of STARS) {
    const depth = s.x * cam.ex + s.y * cam.ey + s.z * cam.ez;
    if (depth <= 0.03) continue;
    const x = cx + (s.x * cam.rx + s.y * cam.ry + s.z * cam.rz) * starScale;
    const y = cy - (s.x * cam.ux + s.y * cam.uy + s.z * cam.uz) * starScale;
    if (x < -4 || x > W + 4 || y < -4 || y > H + 4) continue;
    const twinkle = 0.62 + 0.38 * Math.sin(now * 0.0011 + s.tw);
    ctx.globalAlpha = s.b * twinkle * (0.30 + 0.70 * depth);
    ctx.fillRect(x, y, s.size, s.size);
  }
  ctx.globalAlpha = 1;

  /* ---------- orbital rings ---------- */
  const planeCount = state.planes.length;
  const ringRes = planeCount > 72 ? 88 : (planeCount > 36 ? 108 : 140);
  const ringDraws = [];

  function buildRing(plane, preview) {
    const pts = [];
    for (let k = 0; k <= ringRes; k++) {
      planePos(plane, TAU * k / ringRes, _pa, state.simTime);
      pts.push(project(_pa));
    }
    const front = new Path2D();
    const back = new Path2D();

    for (let k = 1; k <= ringRes; k++) {
      const p0 = pts[k - 1];
      const p1 = pts[k];
      const hidden = occluded(p0) && occluded(p1);
      const path = hidden ? back : front;
      path.moveTo(p0.x, p0.y);
      path.lineTo(p1.x, p1.y);
    }
    return { plane, front, back, preview };
  }

  for (const plane of state.planes) {
    ringDraws.push(buildRing(plane, false));
  }

  let previewColor = null;
  let previewStatus = null;
  if (state.preview && !state.preview.overflow) {
    if (state.preview.analysis) {
      previewStatus = state.preview.analysis.status;
      previewColor = statusColor(previewStatus);
    }
    if (state.preview.plane) {
      ringDraws.push(buildRing(state.preview.plane, true));
    }
  }

  /* hidden arcs, behind Earth */
  for (const r of ringDraws) {
    ctx.globalAlpha = r.preview ? 0.22 : 0.12;
    ctx.strokeStyle = r.preview ? previewColor : r.plane.color;
    ctx.lineWidth = r.preview ? 1.3 : 1.0;
    if (r.preview) ctx.setLineDash([4, 6]);
    ctx.stroke(r.back);
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;

  /* ---------- atmosphere ---------- */
  const atm = ctx.createRadialGradient(cx, cy, baseR * 0.94, cx, cy, baseR * 1.16);
  atm.addColorStop(0, "rgba(66, 168, 255, 0.20)");
  atm.addColorStop(0.55, "rgba(58, 126, 255, 0.055)");
  atm.addColorStop(1, "rgba(58, 126, 255, 0)");
  ctx.fillStyle = atm;
  ctx.beginPath();
  ctx.arc(cx, cy, baseR * 1.16, 0, TAU);
  ctx.fill();

  /* ---------- Earth sphere ---------- */
  const sphere = ctx.createRadialGradient(
    cx - baseR * 0.34, cy - baseR * 0.40, baseR * 0.06,
    cx, cy, baseR * 1.06
  );
  sphere.addColorStop(0, "#2a517b");
  sphere.addColorStop(0.38, "#173354");
  sphere.addColorStop(0.72, "#0b1c34");
  sphere.addColorStop(0.92, "#061120");
  sphere.addColorStop(1, "#040a13");
  ctx.fillStyle = sphere;
  ctx.beginPath();
  ctx.arc(cx, cy, baseR, 0, TAU);
  ctx.fill();

  /* ---------- graticule (front hemisphere only) ---------- */
  ctx.save();
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = "rgba(92, 156, 214, 0.29)";

  function strokeGeoLine(fixed, isParallel) {
    ctx.beginPath();
    let pen = false;
    for (let d = isParallel ? -180 : -90; d <= (isParallel ? 180 : 90); d += 6) {
      const lat = isParallel ? fixed : d;
      const lon = isParallel ? d : fixed;
      earthPoint(lat, lon, _pa);
      const p = project(_pa);
      if (p.depth <= 0.004) { pen = false; continue; }
      if (!pen) { ctx.moveTo(p.x, p.y); pen = true; }
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  for (let lat = -60; lat <= 60; lat += 30) strokeGeoLine(lat, true);
  for (let lon = -180; lon < 180; lon += 30) strokeGeoLine(lon, false);

  ctx.strokeStyle = "rgba(110, 195, 255, 0.52)";
  ctx.lineWidth = 0.9;
  strokeGeoLine(0, true);
  ctx.strokeStyle = "rgba(110, 195, 255, 0.34)";
  strokeGeoLine(0, false);
  ctx.restore();

  /* ---------- visible orbital arcs ---------- */
  for (const r of ringDraws) {
    ctx.globalAlpha = r.preview ? 0.92 : 0.56;
    ctx.strokeStyle = r.preview ? previewColor : r.plane.color;
    ctx.lineWidth = r.preview ? 1.55 : 1.05;
    if (r.preview) ctx.setLineDash([5, 5]);
    ctx.stroke(r.front);
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;

  /* ---------- satellites ---------- */
  const satDraws = [];

  function addSat(sat, ghost) {
    satPos(sat, state.simTime, _pa);
    const p = project(_pa);
    if (occluded(p)) return;
    satDraws.push({
      sat,
      p,
      ghost,
      color: ghost ? previewColor : sat.plane.color
    });
  }

  for (const sat of state.sats) addSat(sat, false);
  if (state.preview && state.preview.plane) {
    for (const sat of state.preview.plane.sats) addSat(sat, true);
  }

  satDraws.sort((a, b) => a.p.depth - b.p.depth);

  state.screenSats = satDraws.map(d => ({
    sat: d.sat,
    x: d.p.x,
    y: d.p.y,
    ghost: d.ghost
  }));

  for (const d of satDraws) {
    const { p, ghost, color, sat } = d;
    const far = p.depth < 0;
    const alpha = ghost ? 0.95 : (far ? 0.72 : 1);
    const hot = state.hoverSat === sat;

    ctx.globalAlpha = (ghost ? 0.26 : 0.15) * alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, ghost ? 7 : 6, 0, TAU);
    ctx.fill();

    ctx.globalAlpha = 0.38 * alpha;
    ctx.beginPath();
    ctx.arc(p.x, p.y, ghost ? 4.6 : 4, 0, TAU);
    ctx.fill();

    ctx.globalAlpha = alpha;
    ctx.fillStyle = ghost ? color : "#e9fff8";
    ctx.beginPath();
    ctx.arc(p.x, p.y, hot ? 3.6 : 2.5, 0, TAU);
    ctx.fill();

    if (ghost || hot) {
      ctx.globalAlpha = ghost ? 0.9 : 0.7;
      ctx.strokeStyle = ghost ? color : "#ffffff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, hot ? 9 : 6.2, 0, TAU);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  /* ---------- closest-pass highlight ---------- */
  if (state.focus) {
    const fa = satDraws.find(d => d.sat === state.focus.sats[0]);
    const fb = satDraws.find(d => d.sat === state.focus.sats[1]);
    if (fa && fb) {
      const analysis = currentViewAnalysis();
      const col = analysis ? statusColor(analysis.status) : "#ffc04d";
      const pulse = 0.62 + 0.38 * Math.sin(now * 0.006);

      ctx.save();
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.72;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(fa.p.x, fa.p.y);
      ctx.lineTo(fb.p.x, fb.p.y);
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.globalAlpha = pulse;
      ctx.lineWidth = 1.6;
      for (const d of [fa, fb]) {
        ctx.beginPath();
        ctx.arc(d.p.x, d.p.y, 9 + 2 * pulse, 0, TAU);
        ctx.stroke();
      }

      satPos(state.focus.sats[0], state.simTime, _pa);
      satPos(state.focus.sats[1], state.simTime, _pb);
      const dx = _pa[0] - _pb[0];
      const dy = _pa[1] - _pb[1];
      const dz = _pa[2] - _pb[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const mx = (fa.p.x + fb.p.x) / 2;
      const my = (fa.p.y + fb.p.y) / 2;
      ctx.globalAlpha = 1;
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const label = fmtKm(dist);
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(4, 10, 18, 0.82)";
      ctx.fillRect(mx - tw / 2 - 5, my - 15, tw + 10, 15);
      ctx.fillStyle = col;
      ctx.fillText(label, mx, my - 7);
      ctx.restore();
    }
  }

  /* ---------- edge vignette ---------- */
  const vig = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.38, cx, cy,
    Math.max(W, H) * 0.78);
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, "rgba(0,0,0,0.32)");
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);
}

/* =========================================================================
   CANVAS INTERACTION
   ========================================================================= */
let dragLastX = 0;
let dragLastY = 0;
let dragDistance = 0;

function hideTooltip() {
  state.hoverSat = null;
  ui.tooltip.classList.remove("show");
}

function updateTooltip(mx, my) {
  let best = null;
  let bestDist = 14;
  for (const s of state.screenSats) {
    const d = Math.hypot(mx - s.x, my - s.y);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }

  if (!best) {
    hideTooltip();
    ui.scene.style.cursor = "grab";
    return;
  }

  state.hoverSat = best.sat;
  ui.scene.style.cursor = "pointer";

  const sat = best.sat;
  const pool = state.sats.concat(
    state.preview && state.preview.plane ? state.preview.plane.sats : []
  );

  let nearest = Infinity;
  let nearestSat = null;
  for (const other of pool) {
    if (other === sat) continue;
    const d2 = pairSqDist(sat, other, state.simTime);
    if (d2 < nearest) {
      nearest = d2;
      nearestSat = other;
    }
  }

  let html = "<b>" + sat.label + "</b>";
  if (best.ghost) {
    html += "<br><span style=\"color:var(--warn)\">Proposed plane &mdash; not committed</span>";
  }
  const raanNow = mod(sat.raan + sat.raanDot * state.simTime * R2D, 360);
  html += "<br>Plane " + sat.plane.label + " &middot; " + sat.plane.count + " sats" +
    "<br>i " + fmtDeg(sat.plane.inc) + " &middot; &Omega; " + fmtDeg(raanNow, 1) +
    "<br>M<sub>0</sub> " + fmtDeg(mod(sat.m0 * R2D, 360), 0) + " &middot; h 550 km" +
    "<br>J2 &Omega;&#775; " + fmtDrift(sat.raanDot) +
    "<br>Nearest now: <b>" + fmtKm(Math.sqrt(nearest)) + "</b>" +
    (nearestSat ? " (" + nearestSat.label + ")" : "");

  ui.tooltip.innerHTML = html;
  ui.tooltip.classList.add("show");

  const tw = ui.tooltip.offsetWidth;
  const th = ui.tooltip.offsetHeight;
  let x = mx + 14;
  let y = my + 14;
  if (x + tw > window.innerWidth - 8) x = mx - tw - 14;
  if (y + th > window.innerHeight - 8) y = my - th - 14;
  ui.tooltip.style.left = x + "px";
  ui.tooltip.style.top = y + "px";
}

function bindCanvasEvents() {
  const el = ui.scene;

  el.addEventListener("pointerdown", e => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    state.dragging = true;
    dragDistance = 0;
    dragLastX = e.clientX;
    dragLastY = e.clientY;
    el.classList.add("dragging");
    el.setPointerCapture(e.pointerId);
    hideTooltip();
  });

  el.addEventListener("pointermove", e => {
    if (state.dragging) {
      const dx = e.clientX - dragLastX;
      const dy = e.clientY - dragLastY;
      dragLastX = e.clientX;
      dragLastY = e.clientY;
      dragDistance += Math.abs(dx) + Math.abs(dy);
      state.cam.yaw = mod(state.cam.yaw - dx * 0.005, TAU);
      state.cam.pitch = clamp(state.cam.pitch + dy * 0.0045, -1.42, 1.42);
    } else {
      updateTooltip(e.clientX, e.clientY);
    }
  });

  function endDrag(e) {
    if (!state.dragging) return;
    state.dragging = false;
    el.classList.remove("dragging");
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (dragDistance < 3) {
      // A simple click clears any closest-pass highlight.
      if (state.focus) {
        state.focus = null;
        state.paused = false;
        updatePauseUI();
      }
    }
  }

  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
  el.addEventListener("pointerleave", () => {
    if (!state.dragging) hideTooltip();
  });

  el.addEventListener("wheel", e => {
    e.preventDefault();
    state.cam.zoom = clamp(state.cam.zoom * Math.exp(-e.deltaY * 0.0012), 0.62, 1.85);
  }, { passive: false });

  el.addEventListener("dblclick", () => {
    state.cam.yaw = 0.58;
    state.cam.pitch = 0.36;
    state.cam.zoom = 1;
    toast("Camera reset", "info");
  });
}

/* =========================================================================
   MAIN LOOP + INIT
   ========================================================================= */
let lastFrame = performance.now();

function loop(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  if (!state.paused) {
    // J2 makes the orbit orientation drift, so the animation is continuous
    // rather than a 24 h loop: wrapping back to t = 0 would visibly snap every
    // plane. The clock still displays time-of-day (plus a day count).
    state.simTime += dt * state.speed;
  }

  renderScene();
  updateHUD(false);
  requestAnimationFrame(loop);
}

function init() {
  bindEvents();
  bindCanvasEvents();
  seedMission();
  setSpeed(state.speed);
  updatePauseUI();
  fitScene();
  updateHUD(true);

  window.addEventListener("resize", () => {
    fitScene();
    drawProfile();
  });

  requestAnimationFrame(loop);
}

init();



