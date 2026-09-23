// SVG-стрелки манёвров для панели навигации. Внутри только числа — безопасно вставлять как разметку.

const RAD = Math.PI / 180;

// Канонический угол стрелки по коду BRouter — чтобы «плавно» и «резко» выглядели по-разному.
const ANGLES = { 1: 0, 2: -90, 3: -45, 4: -135, 5: 90, 6: 45, 7: 135, 8: -30, 9: 30, 17: -45, 18: 45 };

const f = (n) => n.toFixed(1);

function arrowHead(x, y, deg) {
  const dx = Math.sin(deg * RAD);
  const dy = -Math.cos(deg * RAD);
  const tip = [x + dx * 16, y + dy * 16];
  const l = [x - dy * 13, y + dx * 13];
  const r = [x + dy * 13, y - dx * 13];
  return `<path d="M${f(tip[0])} ${f(tip[1])} L${f(l[0])} ${f(l[1])} L${f(r[0])} ${f(r[1])} Z" fill="currentColor"/>`;
}

function turn(deg, { ghost = null, ring = false } = {}) {
  const jx = 50, jy = 58;
  const ex = jx + Math.sin(deg * RAD) * 30;
  const ey = jy - Math.cos(deg * RAD) * 30;
  let s = '';
  // «Держитесь левее/правее» — бледная вторая ветка развилки.
  if (ghost != null) {
    const gx = jx + Math.sin(ghost * RAD) * 30;
    const gy = jy - Math.cos(ghost * RAD) * 30;
    s += `<path d="M${jx} ${jy} L${f(gx)} ${f(gy)}" stroke="currentColor" stroke-opacity=".3" stroke-width="10" stroke-linecap="round" fill="none"/>`;
  }
  if (ring) s += `<circle cx="${jx}" cy="${jy}" r="13" stroke="currentColor" stroke-width="7" fill="none"/>`;
  s += `<path d="M50 94 L${jx} ${jy} L${f(ex)} ${f(ey)}" stroke="currentColor" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
  s += arrowHead(ex, ey, deg);
  return s;
}

function uturn(right) {
  const [a, b] = right ? [38, 70] : [62, 30];
  return `<path d="M${a} 92 L${a} 42 A16 16 0 0 ${right ? 1 : 0} ${b} 42 L${b} 56" stroke="currentColor" stroke-width="10" stroke-linecap="round" fill="none"/>`
    + arrowHead(b, 56, 180);
}

const FINISH = '<circle cx="50" cy="50" r="30" stroke="currentColor" stroke-width="9" fill="none"/><circle cx="50" cy="50" r="12" fill="currentColor"/>';

// m — результат upcoming(): { cmd, angle, exit } или { arrive: true }.
export function arrowSvg(m) {
  let body;
  if (!m || m.arrive) body = FINISH;
  else if (m.cmd >= 10 && m.cmd <= 12) body = uturn(m.cmd === 12 || m.angle > 0);
  else if (m.cmd === 14 || m.cmd === 15) body = turn(Math.max(-135, Math.min(135, m.angle || 0)), { ring: true });
  else if (m.cmd === 8) body = turn(-30, { ghost: 25 });
  else if (m.cmd === 9) body = turn(30, { ghost: -25 });
  else body = turn(ANGLES[m.cmd] ?? Math.max(-135, Math.min(135, m.angle || 0)));
  return `<svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden="true">${body}</svg>`;
}
