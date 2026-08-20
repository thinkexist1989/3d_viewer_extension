const RAIL_ORIGIN = [-4.089, -2.005, 3.89559784];
const ARM_CHAIN = [
  { origin: [0.32, 0.785, -0.06], axis: [0, -1, 0] },
  { origin: [-0.32, -0.785, 0.06], axis: [0, 0, 1] },
  { origin: [0, -1.19, -0.3625], axis: [0, 0, 1] },
  { origin: [-0.288, -0.2, 0.3025], axis: [-1, 0, 0] },
  { origin: [-1.392, 0, 0.109], axis: [0, 0, 1] },
  { origin: [-0.17198919, 0, -0.109], axis: [-1, 0, 0] }
];
// 墨斗表是 SolidWorks CAD 轴系、相对 J1 基座。URDF 视觉 = Rx(90)*CAD，
// 所以 CAD (x,y,z) → 导轨后 (x, -z, y)，再平移到 J1。
const J1_IN_RAIL = ARM_CHAIN[0].origin;
const RX90 = [
  [1, 0, 0],
  [0, 0, -1],
  [0, 1, 0]
];

function matMul(a, b) {
  const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return r;
}

function rpyMatrix(r, p, y) {
  const cx = Math.cos(r);
  const sx = Math.sin(r);
  const cy = Math.cos(p);
  const sy = Math.sin(p);
  const cz = Math.cos(y);
  const sz = Math.sin(y);
  const rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
  const ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  return matMul(rz, matMul(ry, rx));
}

function axisMatrix(axis, q) {
  const n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const x = axis[0] / n;
  const y = axis[1] / n;
  const z = axis[2] / n;
  const c = Math.cos(q);
  const s = Math.sin(q);
  const C = 1 - c;
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C]
  ];
}

function tMul(a, b) {
  return {
    R: matMul(a.R, b.R),
    t: [
      a.t[0] + a.R[0][0] * b.t[0] + a.R[0][1] * b.t[1] + a.R[0][2] * b.t[2],
      a.t[1] + a.R[1][0] * b.t[0] + a.R[1][1] * b.t[1] + a.R[1][2] * b.t[2],
      a.t[2] + a.R[2][0] * b.t[0] + a.R[2][1] * b.t[1] + a.R[2][2] * b.t[2]
    ]
  };
}

function tXyz(xyz) {
  return { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: xyz.slice() };
}

export function wrapAngle(q) {
  let a = q;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function fkArm(railM, q) {
  let T = tMul(tXyz(RAIL_ORIGIN), tXyz([0, 0, railM]));
  for (let i = 0; i < 6; i += 1) {
    T = tMul(T, tXyz(ARM_CHAIN[i].origin));
    T = tMul(T, { R: axisMatrix(ARM_CHAIN[i].axis, q[i]), t: [0, 0, 0] });
  }
  return T;
}

function so3Error(R, Rd) {
  const Rt = [
    [Rd[0][0], Rd[1][0], Rd[2][0]],
    [Rd[0][1], Rd[1][1], Rd[2][1]],
    [Rd[0][2], Rd[1][2], Rd[2][2]]
  ];
  const M = matMul(Rt, R);
  return [0.5 * (M[2][1] - M[1][2]), 0.5 * (M[0][2] - M[2][0]), 0.5 * (M[1][0] - M[0][1])];
}

function poseError(T, Rd, pd) {
  return [T.t[0] - pd[0], T.t[1] - pd[1], T.t[2] - pd[2], ...so3Error(T.R, Rd)];
}

function jacobian(railM, q, Rd, pd) {
  const h = 1e-6;
  const T = fkArm(railM, q);
  const e = poseError(T, Rd, pd);
  const J = Array.from({ length: 6 }, () => [0, 0, 0, 0, 0, 0]);
  for (let j = 0; j < 6; j += 1) {
    const q2 = q.slice();
    q2[j] += h;
    const T2 = fkArm(railM, q2);
    const e2 = poseError(T2, Rd, pd);
    for (let i = 0; i < 6; i += 1) {
      J[i][j] = (e2[i] - e[i]) / h;
    }
  }
  return { J, e };
}

function solveDls(A, b) {
  const n = 6;
  const lambda = 2e-3;
  const M = Array.from({ length: n }, (_, i) => {
    const row = [];
    for (let j = 0; j < n; j += 1) {
      let s = 0;
      for (let k = 0; k < 6; k += 1) s += A[k][i] * A[k][j];
      row.push(s + (i === j ? lambda : 0));
    }
    let rhs = 0;
    for (let k = 0; k < 6; k += 1) rhs += A[k][i] * b[k];
    row.push(rhs);
    return row;
  });
  for (let i = 0; i < n; i += 1) {
    let piv = i;
    for (let r = i + 1; r < n; r += 1) {
      if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
    }
    [M[i], M[piv]] = [M[piv], M[i]];
    if (Math.abs(M[i][i]) < 1e-12) return [0, 0, 0, 0, 0, 0];
    const f = M[i][i];
    for (let j = i; j <= n; j += 1) M[i][j] /= f;
    for (let r = 0; r < n; r += 1) {
      if (r === i) continue;
      const g = M[r][i];
      for (let j = i; j <= n; j += 1) M[r][j] -= g * M[i][j];
    }
  }
  return M.map((row) => row[n]);
}

export function solveIk(railM, pd, Rd, qSeed = [0, 0, 0, 0, 0, 0]) {
  let q = qSeed.map(wrapAngle);
  let err = Infinity;
  for (let it = 0; it < 80; it += 1) {
    const { J, e } = jacobian(railM, q, Rd, pd);
    err = Math.hypot(...e);
    if (err < 1e-4) return { ok: true, q, err, iterations: it };
    const dq = solveDls(J, e.map((v) => -v));
    const step = err > 0.5 ? 0.4 : 1;
    q = q.map((v, i) => wrapAngle(v + step * dq[i]));
  }
  return { ok: err < 0.03, q, err, iterations: 80 };
}

export function solveIkRobust(railM, pd, Rd, qSeed = [0, 0, 0, 0, 0, 0]) {
  const seeds = [qSeed, [0, 0, 0, 0, 0, 0], [0, 0.4, -0.8, 0, 0.8, 0]];
  let best = { ok: false, err: Infinity, q: qSeed, iterations: 0 };
  for (const seed of seeds) {
    const cand = solveIk(railM, pd, Rd, seed);
    if (cand.err < best.err) best = cand;
    if (cand.ok && cand.err < 1e-3) break;
  }
  return best;
}

export function modouPointToRail(pmCad) {
  return [
    J1_IN_RAIL[0] + pmCad[0],
    J1_IN_RAIL[1] - pmCad[2],
    J1_IN_RAIL[2] + pmCad[1]
  ];
}

function rMul(R, v) {
  return [
    R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
    R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
    R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]
  ];
}

export function waypointToJ6Target(wp, toolZmm = 450, railMOverride = null) {
  // 墨斗 TCP1 = STOOL(0,0,450,0,0,0)：法兰沿工具+Z 到 TCP。
  // J6 = TCP - R(rpy) * (0,0,|toolZ|)。取料 rpy=Rx(180) 时法兰在 TCP 的 +Z，不是 -Z。
  const railM = railMOverride != null ? Number(railMOverride) : Number(wp.rail_mm) / 1000;
  const tcpCad = [wp.x / 1000, wp.y / 1000, wp.z / 1000];
  const RdCad = rpyMatrix(
    (wp.rx * Math.PI) / 180,
    (wp.ry * Math.PI) / 180,
    (wp.rz * Math.PI) / 180
  );
  const offset = rMul(RdCad, [0, 0, Math.abs(Number(toolZmm)) / 1000]);
  const j6Cad = [tcpCad[0] - offset[0], tcpCad[1] - offset[1], tcpCad[2] - offset[2]];
  const pm = modouPointToRail(j6Cad);
  const Rd = matMul(RX90, RdCad);
  const base = tMul(tXyz(RAIL_ORIGIN), tXyz([0, 0, railM]));
  const Tw = tMul(base, { R: Rd, t: pm });
  return { railM, pd: Tw.t, Rd: Tw.R, tcpCad, j6Cad, pmRail: pm, toolOffsetCad: offset };
}

const MODOU_MDH = [
  { a: 0, alpha: 0, d: 0.785, theta: 0 },
  { a: 0.32, alpha: Math.PI / 2, d: 0, theta: Math.PI / 2 },
  { a: 1.19, alpha: 0, d: 0, theta: 0 },
  { a: 0.2, alpha: Math.PI / 2, d: 1.68, theta: Math.PI },
  { a: 0, alpha: Math.PI / 2, d: 0, theta: Math.PI },
  { a: 0, alpha: Math.PI / 2, d: 0.2, theta: Math.PI }
];

function mdhLayer(p, q) {
  return tMul(
    tMul(
      tMul({ R: axisMatrix([1, 0, 0], p.alpha), t: [0, 0, 0] }, tXyz([p.a, 0, 0])),
      { R: axisMatrix([0, 0, 1], p.theta + q), t: [0, 0, 0] }
    ),
    tXyz([0, 0, p.d])
  );
}

export function fkModou(qRad) {
  let T = tXyz([0, 0, 0]);
  for (let i = 0; i < 6; i += 1) {
    T = tMul(T, mdhLayer(MODOU_MDH[i], qRad[i]));
  }
  return T;
}

export function modouFlangeToUrdfWorld(Tm, railM = 0) {
  const pm = modouPointToRail(Tm.t);
  const Rd = matMul(RX90, Tm.R);
  const base = tMul(tXyz(RAIL_ORIGIN), tXyz([0, 0, railM]));
  return tMul(base, { R: Rd, t: pm });
}

// 墨斗 J1–J6 → 插件同名轴。J1 +180° 是两边零位差。
// URDF 多一个与 J4 共轴的 link_008，始终为 0，不占用 J5。
export function modouJointsToUrdf(qDeg) {
  const m = qDeg.map((d) => Number(d));
  // J1 只加 180° 零位，不 wrap：取料 2.8° → 装配 181°，与墨斗 -177° → 1° 同向。
  const mapped = [m[0] + 180, m[1], m[2], m[3], m[4], m[5]];
  return {
    ok: true,
    q: mapped.map((deg) => (deg * Math.PI) / 180),
    err: 0,
    iterations: 0,
    mode: "taught"
  };
}
