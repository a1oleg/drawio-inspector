export function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
