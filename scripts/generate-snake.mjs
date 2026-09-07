import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const LEVELS = ['NONE', 'FIRST_QUARTILE', 'SECOND_QUARTILE', 'THIRD_QUARTILE', 'FOURTH_QUARTILE'];
export const FOOD_PER_SEGMENT = 3;
const THEMES = {
  light: {
    dots: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'],
    snake: '#8250df',
    head: '#6639ba',
    hud: '#f6f8fa',
    hudBorder: '#d0d7de',
    hudLabel: '#57606a',
    hudValue: '#6639ba',
  },
  dark: {
    dots: ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'],
    snake: '#a371f7',
    head: '#d2a8ff',
    hud: '#0d1117',
    hudBorder: '#30363d',
    hudLabel: '#8b949e',
    hudValue: '#d2a8ff',
  },
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

function createSafeRoute(width, height) {
  const route = [];
  for (let y = 0; y < height; y++) {
    for (let column = 0; column < width; column++) route.push({ x: y % 2 === 0 ? column : width - 1 - column, y });
  }
  return route;
}

function shuffle(values, random) {
  for (let index = values.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [values[index], values[other]] = [values[other], values[index]];
  }
  return values;
}

function findPath(start, target, blocked, width, height, variation = 0) {
  const startKey = key(start);
  const parents = new Map([[startKey, null]]);
  const points = new Map([[startKey, start]]);
  const queue = [start];
  const directions = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const point = queue[cursor];
    if (target(point)) {
      const path = [];
      let pointKey = key(point);
      while (parents.get(pointKey) !== null) {
        path.push(points.get(pointKey));
        pointKey = parents.get(pointKey);
      }
      return path.reverse();
    }

    const offset = Math.abs(Math.imul(point.x + 3, 73856093) ^ Math.imul(point.y + 3, 19349663) ^ variation) % 4;
    for (let index = 0; index < directions.length; index++) {
      const direction = directions[(index + offset) % directions.length];
      const next = { x: point.x + direction.x, y: point.y + direction.y };
      const nextKey = key(next);
      if (next.x < -2 || next.x > width + 1 || next.y < -2 || next.y > height + 1
        || blocked.has(nextKey) || parents.has(nextKey)) continue;
      parents.set(nextKey, key(point));
      points.set(nextKey, next);
      queue.push(next);
    }
  }
  return null;
}

function outsideDirection(point, width, height) {
  if (point.x < 0) return { x: -1, y: 0 };
  if (point.x >= width) return { x: 1, y: 0 };
  if (point.y < 0) return { x: 0, y: -1 };
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
  const run = (gameMode) => {
    const food = new Set(cells.filter((cell) => cell.count > 0).map(key));
    const eatenAt = new Map();
    let body = Array.from({ length: 4 }, (_, index) => ({ x: -1 - index, y: gameMode ? 3 : 0 }));
    const frames = [body];
    const births = [0, 0, 0, 0];
    const route = [];
    const advance = (head) => {
      const willEat = food.has(key(head));
      const willGrow = willEat && (eatenAt.size + 1) % FOOD_PER_SEGMENT === 0;
      const occupied = willGrow ? body : body.slice(0, -1);
      if (occupied.some((point) => point.x === head.x && point.y === head.y)) return false;
      const ate = food.delete(key(head));
      body = [head, ...body];
      if (ate) {
        eatenAt.set(key(head), frames.length);
        if (willGrow) births.push(frames.length);
      }
      if (!willGrow) body.pop();
      frames.push(body);
      route.push(head);
      return true;
    };

    if (gameMode) {
      const random = randomGenerator(calendarSeed(cells));
      const targets = shuffle(cells.filter((cell) => cell.count > 0).map(({ x, y }) => ({ x, y })), random);
      const maxSteps = width * 7 * 12 + targets.length * 8;
      let steps = 0;

      while (food.size && steps++ < maxSteps) {
        const directions = shuffle([
          { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 },
        ], random);
        const legalMoves = directions.map((direction) => ({
          x: body[0].x + direction.x,
          y: body[0].y + direction.y,
        })).filter((next) => {
          if (next.x < -2 || next.x > width + 1 || next.y < -2 || next.y > 8) return false;
          const grows = food.has(key(next)) && (eatenAt.size + 1) % FOOD_PER_SEGMENT === 0;
          return !(grows ? body : body.slice(0, -1)).some((point) => key(point) === key(next));
        }).map((next) => {
          const grows = food.has(key(next)) && (eatenAt.size + 1) % FOOD_PER_SEGMENT === 0;
          const nextBody = [next, ...body];
          if (!grows) nextBody.pop();
          const nextTail = nextBody.at(-1);
          const nextBlocked = new Set(nextBody.slice(0, -1).map(key));
          const tailPath = findPath(next, (point) => point.x === nextTail.x && point.y === nextTail.y,
            nextBlocked, width, 7, Math.floor(random() * 0x7fffffff));
          return { next, nextBlocked, safe: tailPath !== null };
        });
        const safeMoves = legalMoves.filter(({ safe }) => safe);
        const moves = safeMoves.length ? safeMoves : legalMoves;

        let choice = null;
        for (const target of targets) {
          if (!food.has(key(target))) continue;
          const options = moves.map((move) => ({
            ...move,
            path: findPath(move.next, (point) => point.x === target.x && point.y === target.y,
              move.nextBlocked, width, 7, Math.floor(random() * 0x7fffffff)),
          })).filter(({ path }) => path !== null)
            .sort((a, b) => a.path.length - b.path.length);
          if (options.length) {
            choice = options[0].next;
            break;
          }
        }

        // If the body temporarily separates every food cell, keep moving safely
        // alongside the tail until a route opens again.
        if (!choice) choice = moves[0]?.next;
        if (!choice || !advance(choice)) return null;
      }
      if (food.size) return null;
    } else {
      for (const point of createSafeRoute(width, 7)) {
        if (!advance(point)) return null;
      }
    }

    const finalLength = body.length;
    const blocked = new Set(body.slice(0, -1).map(key));
    const exitPath = findPath(body[0], (point) => point.x < 0 || point.x >= width || point.y < 0 || point.y >= 7,
      blocked, width, 7, calendarSeed(cells));
    if (!exitPath) return null;
    for (const point of exitPath) if (!advance(point)) return null;

    const direction = outsideDirection(body[0], width, 7);
    for (let step = 0; step < finalLength + 2; step++) {
      const head = body[0];
      if (!advance({ x: head.x + direction.x, y: head.y + direction.y })) return null;
    }
    return { width, cells, frames, births, eatenAt, finalLength, route, strategy: gameMode ? 'game' : 'safe-route' };
  };

  // Dense or adversarial calendars can fill the entire board. The exhaustive
  // route is retained only as a guaranteed fallback for those extreme inputs.
  return run(true) || run(false);
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
  const boardTop = 58;
  const svgWidth = width * pitch + padding * 2 - 4;
  const svgHeight = boardTop + 7 * pitch + 16;
  const startPause = 10;
  const endPause = 16;
  const total = startPause + frames.length - 1 + endPause;
  const duration = (total * 0.09).toFixed(2);
  const percent = (t) => `${Number((t / total * 100).toFixed(6))}%`;
  const position = (point) => ({
    x: padding + Math.max(-2, Math.min(width + 1, point.x)) * pitch,
    y: boardTop + point.y * pitch,
  });
  const styles = [
    `.moving{animation-duration:${duration}s;animation-iteration-count:infinite;animation-timing-function:linear}`,
    '.food,.birth,.hud-values{animation-timing-function:steps(1,end)}',
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
    const y = boardTop + cell.y * pitch;
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

  const eatenFrames = [...eatenAt.values()];
  const hudStates = [0, ...eatenFrames].map((frame, eaten) => ({
    frame: eaten === 0 ? 0 : startPause + frame,
    score: eaten * 100,
    level: 1 + Math.floor(eaten / 10),
    length: 4 + Math.floor(eaten / FOOD_PER_SEGMENT),
    combo: eaten === 0 ? 0 : ((eaten - 1) % 5) + 1,
  }));
  const hudRowHeight = 18;
  if (hudStates.length > 1) {
    const keyframes = hudStates.map((state, index) =>
      `${percent(state.frame)}{transform:translateY(-${index * hudRowHeight}px)}`).join('');
    styles.push(`@keyframes hud-values{${keyframes}100%{transform:translateY(-${(hudStates.length - 1) * hudRowHeight}px)}}`);
  }
  const columnWidth = (svgWidth - 40) / 4;
  const hudRows = hudStates.map((state, index) => {
    const values = [
      String(state.score).padStart(4, '0'),
      String(state.level).padStart(2, '0'),
      String(state.length).padStart(2, '0'),
      `x${state.combo}`,
    ].map((value, column) => `<text x="${20 + column * columnWidth}" y="${35 + index * hudRowHeight}">${value}</text>`).join('');
    return `<g>${values}</g>`;
  }).join('');
  const hudAnimation = hudStates.length > 1
    ? ' class="hud-values moving" style="animation-name:hud-values;transform:translateY(0)"'
    : '';
  const hudFrames = `<g clip-path="url(#hud-window)"><g${hudAnimation}>${hudRows}</g></g>`;
  const hudLabels = ['SCORE', 'LEVEL', 'LENGTH', 'COMBO']
    .map((label, column) => `<text x="${20 + column * columnWidth}" y="20">${label}</text>`).join('');
  const hud = `<g class="hud" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-weight="700">
<rect x="8" y="5" width="${svgWidth - 16}" height="36" rx="8" fill="${palette.hud}" stroke="${palette.hudBorder}"/>
<g fill="${palette.hudLabel}" font-size="8" letter-spacing="1">${hudLabels}</g>
<g fill="${palette.hudValue}" font-size="13">${hudFrames}</g>
</g>`;
  styles.push('@media(prefers-reduced-motion:reduce){.moving{animation:none!important}.snake{display:none}.food{opacity:1}}');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}" role="img" aria-labelledby="title description">
<title id="title">${escapeXml(username)}'s growing contribution snake</title>
<desc id="description">A game HUD tracks score, level, length, and combo. The snake gains one segment after every ${FOOD_PER_SEGMENT} active contribution cells it eats, growing from 4 to ${finalLength} segments. After its tail exits, the calendar resets. Reduced motion shows the complete calendar.</desc>
<style>${styles.join('\n')}</style>
<defs>
<clipPath id="board"><rect x="20" y="${boardTop - 4}" width="${width * pitch + 8}" height="120"/></clipPath>
<clipPath id="hud-window"><rect x="16" y="22" width="${svgWidth - 32}" height="17"/></clipPath>
</defs>
${hud}${grid}<g class="snake" clip-path="url(#board)">${segments}</g>
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
