import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const LEVELS = ['NONE', 'FIRST_QUARTILE', 'SECOND_QUARTILE', 'THIRD_QUARTILE', 'FOURTH_QUARTILE'];
const THEMES = {
  light: { dots: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'], snake: '#8250df', head: '#6639ba' },
  dark: { dots: ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'], snake: '#a371f7', head: '#d2a8ff' },
};
const key = ({ x, y }) => `${x},${y}`;
const escapeXml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

function calendarSeed(cells) {
  let hash = 2166136261;
  for (const cell of cells) {
    for (const character of `${cell.date}:${cell.count};`) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
}

function randomGenerator(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Backbite moves turn the regular column sweep into an organic Hamiltonian
// route. The saved route always has boundary endpoints, so the snake can enter
// and leave cleanly while still visiting every cell exactly once.
export function createRoute(width, height, seed) {
  let route = [];
  for (let x = 0; x < width; x++) {
    for (let row = 0; row < height; row++) route.push({ x, y: x % 2 === 0 ? row : height - 1 - row });
  }
  let best = route;
  const random = randomGenerator(seed);
  const boundary = ({ x, y }) => x === 0 || x === width - 1 || y === 0 || y === height - 1;
  const attempts = Math.max(500, route.length * 2);

  for (let attempt = 0; attempt < attempts; attempt++) {
    const indexes = new Map(route.map((point, index) => [key(point), index]));
    const fromEnd = random() < 0.5;
    const endpoint = fromEnd ? route.at(-1) : route[0];
    const candidates = [
      { x: endpoint.x - 1, y: endpoint.y },
      { x: endpoint.x + 1, y: endpoint.y },
      { x: endpoint.x, y: endpoint.y - 1 },
      { x: endpoint.x, y: endpoint.y + 1 },
    ].filter(({ x, y }) => x >= 0 && x < width && y >= 0 && y < height)
      .map((point) => indexes.get(key(point)))
      .filter((index) => fromEnd ? index < route.length - 2 : index > 1);

    if (!candidates.length) continue;
    const index = candidates[Math.floor(random() * candidates.length)];
    route = fromEnd
      ? route.slice(0, index + 1).concat(route.slice(index + 1).reverse())
      : route.slice(0, index).reverse().concat(route.slice(index));
    if (boundary(route[0]) && boundary(route.at(-1))) best = route;
  }
  return best;
}

function outwardDirection(point, width, height) {
  if (point.x === 0) return { x: -1, y: 0 };
  if (point.x === width - 1) return { x: 1, y: 0 };
  if (point.y === 0) return { x: 0, y: -1 };
  return { x: 0, y: 1 };
}

export function parseCalendar(calendar) {
  if (!Array.isArray(calendar?.weeks) || calendar.weeks.length < 1 || calendar.weeks.length > 54) {
    throw new Error('Expected a contribution calendar containing 1–54 weeks.');
  }
  const cells = calendar.weeks.flatMap((week, x) => {
    if (!Array.isArray(week.contributionDays)) throw new Error('Missing contributionDays.');
    const weekdays = new Set();
    return week.contributionDays.map((day) => {
      const level = LEVELS.indexOf(day.contributionLevel);
      if (!Number.isInteger(day.weekday) || day.weekday < 0 || day.weekday > 6 || weekdays.has(day.weekday)
        || !Number.isInteger(day.contributionCount) || day.contributionCount < 0 || level < 0
        || typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)
        || (day.contributionCount === 0) !== (level === 0)) {
        throw new Error('Invalid contribution day.');
      }
      weekdays.add(day.weekday);
      return { x, y: day.weekday, count: day.contributionCount, level, date: day.date };
    });
  });
  if (!cells.length) throw new Error('Contribution calendar has no days.');
  return { width: calendar.weeks.length, cells };
}

export async function fetchCalendar(username, token, fetchImpl = fetch) {
  if (!username || !token) throw new Error('GITHUB_USER and GITHUB_TOKEN are required (or use --fixture).');
  const response = await fetchImpl('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'growing-contribution-snake' },
    body: JSON.stringify({
      query: 'query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{weeks{contributionDays{date weekday contributionCount contributionLevel}}}}}}',
      variables: { login: username },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub contribution request failed (HTTP ${response.status}).`);
  const payload = await response.json();
  if (payload.errors?.length) throw new Error('GitHub GraphQL returned errors; check the username and token permissions.');
  const calendar = payload.data?.user?.contributionsCollection?.contributionCalendar;
  if (!calendar) throw new Error('GitHub user or contribution calendar was not found.');
  return calendar;
}

export function simulate(calendar) {
  const { width, cells } = parseCalendar(calendar);
  const food = new Set(cells.filter((cell) => cell.count > 0).map(key));
  const eatenAt = new Map();
  const route = createRoute(width, 7, calendarSeed(cells));
  const startDirection = outwardDirection(route[0], width, 7);
  let body = Array.from({ length: 4 }, (_, i) => ({
    x: route[0].x + startDirection.x * (i + 1),
    y: route[0].y + startDirection.y * (i + 1),
  }));
  const frames = [body];
  const births = [0, 0, 0, 0];
  // Every grid position is still visited exactly once. This remains
  // collision-free even when every day contains food.
  const advance = (head) => {
    body = [head, ...body];
    if (food.delete(key(head))) {
      eatenAt.set(key(head), frames.length);
      births.push(frames.length);
    } else {
      body.pop();
    }
    frames.push(body);
  };
  for (const point of route) advance(point);
  // Continue through the nearest edge until the entire tail is outside.
  const finalLength = body.length;
  const end = route.at(-1);
  const exitDirection = outwardDirection(end, width, 7);
  for (let step = 1; step <= finalLength + 2; step++) {
    advance({ x: end.x + exitDirection.x * step, y: end.y + exitDirection.y * step });
  }
  return { width, cells, frames, births, eatenAt, finalLength, route };
}

// Preserve turns and pauses, but omit intermediate points with equal velocity.
export function simplify(points) {
  return points.filter((point, i) => {
    if (i === 0 || i === points.length - 1) return true;
    const before = points[i - 1];
    const after = points[i + 1];
    return (point.x - before.x) * (after.t - point.t) !== (after.x - point.x) * (point.t - before.t)
      || (point.y - before.y) * (after.t - point.t) !== (after.y - point.y) * (point.t - before.t);
  });
}

export function renderSvg(simulation, { theme = 'light', username = 'GitHub' } = {}) {
  const palette = THEMES[theme];
  if (!palette) throw new Error(`Unknown theme: ${theme}`);
  const { width, cells, frames, births, eatenAt, finalLength } = simulation;
  const pitch = 16;
  const padding = 24;
  const startPause = 10;
  const endPause = 16;
  const total = startPause + frames.length - 1 + endPause;
  const duration = (total * 0.09).toFixed(2);
  const percent = (t) => `${Number((t / total * 100).toFixed(6))}%`;
  const position = (point) => ({ x: padding + Math.max(-2, Math.min(width + 1, point.x)) * pitch, y: padding + point.y * pitch });
  const styles = [
    `.moving{animation-duration:${duration}s;animation-iteration-count:infinite;animation-timing-function:linear}`,
    '.food,.birth{animation-timing-function:steps(1,end)}',
  ];
  // Segment i follows the head exactly i steps later. Share a single motion
  // animation instead of duplicating hundreds of nearly identical keyframes.
  // Delayed loop resets happen offscreen; births and food use the global clock.
  const first = position(frames[0][0]);
  const points = [{ t: 0, ...first }, { t: startPause, ...first }];
  for (let frame = 1; frame < frames.length; frame++) {
    points.push({ t: startPause + frame, ...position(frames[frame][0]) });
  }
  points.push({ t: total, ...position(frames.at(-1)[0]) });
  styles.push(`@keyframes travel{${simplify(points).map((p) => `${percent(p.t)}{transform:translate(${p.x}px,${p.y}px)}`).join('')}}`);
  const grid = cells.map((cell) => {
    const x = padding + cell.x * pitch;
    const y = padding + cell.y * pitch;
    const rect = `x="${x}" y="${y}" width="12" height="12" rx="2"`;
    let markup = `<rect ${rect} fill="${palette.dots[0]}"/>`;
    if (cell.count > 0) {
      const name = `food-${cell.x}-${cell.y}`;
      styles.push(`@keyframes ${name}{0%{opacity:1}${percent(startPause + eatenAt.get(key(cell)))}{opacity:0}100%{opacity:0}}`);
      markup += `<rect ${rect} fill="${palette.dots[cell.level]}" class="food moving" style="animation-name:${name}"/>`;
    }
    return `<g><title>${escapeXml(cell.date)}: ${cell.count} contributions</title>${markup}</g>`;
  }).join('');
  const segments = births.map((birth, index) => {
    let rect = `<rect width="12" height="12" rx="${index === 0 ? 4 : 3}" fill="${index === 0 ? palette.head : palette.snake}" class="moving" style="animation-name:travel;animation-delay:${(index * 0.09).toFixed(2)}s;transform:translate(${first.x}px,${first.y}px)"/>`;
    if (birth > 0) {
      styles.push(`@keyframes birth-${index}{0%{opacity:0}${percent(startPause + birth)}{opacity:1}100%{opacity:1}}`);
      rect = `<g class="birth moving" style="animation-name:birth-${index};opacity:0">${rect}</g>`;
    }
    return rect;
  }).reverse().join('');
  styles.push('@media(prefers-reduced-motion:reduce){.moving{animation:none!important}.snake{display:none}.food{opacity:1}}');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width * pitch + padding * 2 - 4}" height="156" viewBox="0 0 ${width * pitch + padding * 2 - 4} 156" role="img" aria-labelledby="title description">
<title id="title">${escapeXml(username)}'s growing contribution snake</title>
<desc id="description">The snake gains one segment per active contribution day, growing from 4 to ${finalLength} segments. After its tail exits, the calendar resets. Reduced motion shows the complete calendar.</desc>
<style>${styles.join('\n')}</style>
<defs><clipPath id="board"><rect x="20" y="16" width="${width * pitch + 8}" height="124"/></clipPath></defs>
${grid}<g class="snake" clip-path="url(#board)">${segments}</g>
</svg>\n`;
}

async function main() {
  const args = process.argv.slice(2);
  let fixture;
  let outDir = 'dist';
  for (let i = 0; i < args.length; i++) {
    if (!['--fixture', '--out-dir'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Usage: node scripts/generate-snake.mjs [--fixture calendar.json] [--out-dir dist]');
    }
    if (args[i] === '--fixture') fixture = args[++i];
    else outDir = args[++i];
  }
  const username = process.env.GITHUB_USER || (fixture ? 'Preview' : undefined);
  const calendar = fixture ? JSON.parse(await readFile(fixture, 'utf8')) : await fetchCalendar(username, process.env.GITHUB_TOKEN);
  const simulation = simulate(calendar);
  await mkdir(outDir, { recursive: true });
  for (const theme of ['light', 'dark']) {
    const file = `github-contribution-grid-snake${theme === 'dark' ? '-dark' : ''}.svg`;
    await writeFile(resolve(outDir, file), renderSvg(simulation, { theme, username }));
  }
  console.log(`Generated light/dark SVGs: ${simulation.eatenAt.size} active days, length 4 → ${simulation.finalLength}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
