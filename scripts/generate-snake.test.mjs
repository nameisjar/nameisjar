import assert from 'node:assert/strict';
import test from 'node:test';
import { FOOD_PER_SEGMENT, fetchCalendar, parseCalendar, renderSvg, simplify, simulate } from './generate-snake.mjs';

function calendar(width, active = () => false) {
  return {
    weeks: Array.from({ length: width }, (_, x) => ({
      contributionDays: Array.from({ length: 7 }, (_, y) => ({
        date: new Date(Date.UTC(2025, 0, 5 + x * 7 + y)).toISOString().slice(0, 10),
        weekday: y,
        contributionCount: active(x, y) ? 12 : 0,
        contributionLevel: active(x, y) ? 'FOURTH_QUARTILE' : 'NONE',
      })),
    })),
  };
}

for (const [name, input] of [
  ['empty calendar', calendar(53)],
  ['one active day', calendar(53, (x, y) => x === 24 && y === 3)],
  ['sparse calendar', calendar(53, (x, y) => (x * 7 + y) % 11 === 0)],
  ['fully active calendar', calendar(54, () => true)],
  ['one week', calendar(1, () => true)],
]) {
  test(`${name}: exact growth, adjacent body, no collisions, complete exit`, () => {
    const result = simulate(input);
    const food = new Set(result.cells.filter((c) => c.count > 0).map((c) => `${c.x},${c.y}`));
    const originalFoodCount = food.size;
    let eaten = 0;
    for (let i = 1; i < result.frames.length; i++) {
      const previous = result.frames[i - 1];
      const body = result.frames[i];
      const eating = food.delete(`${body[0].x},${body[0].y}`);
      if (eating) eaten++;
      const growing = eating && eaten % FOOD_PER_SEGMENT === 0;
      assert.equal(body.length, previous.length + Number(growing));
      assert.deepEqual(body.slice(1), growing ? previous : previous.slice(0, -1));
      assert.equal(Math.abs(body[0].x - previous[0].x) + Math.abs(body[0].y - previous[0].y), 1);
      assert.equal(new Set(body.map((c) => `${c.x},${c.y}`)).size, body.length);
      for (let j = 1; j < body.length; j++) {
        assert.equal(Math.abs(body[j].x - body[j - 1].x) + Math.abs(body[j].y - body[j - 1].y), 1);
      }
    }
    assert.equal(food.size, 0);
    assert.equal(result.eatenAt.size, originalFoodCount);
    assert.equal(result.finalLength, 4 + Math.floor(originalFoodCount / FOOD_PER_SEGMENT));
    assert.ok(result.frames.at(-1).every((c) => c.x < 0 || c.x >= result.width || c.y < 0 || c.y >= 7));
    assert.equal(result.births.length, result.finalLength);
  });
}

test('sparse calendar uses game-like food seeking instead of sweeping every cell', () => {
  const width = 53;
  const result = simulate(calendar(width, (x, y) => (x * 7 + y) % 11 === 0));
  const boardCells = result.route.filter(({ x, y }) => x >= 0 && x < width && y >= 0 && y < 7);
  assert.equal(result.strategy, 'game');
  assert.ok(new Set(boardCells.map((point) => `${point.x},${point.y}`)).size < width * 7);
  assert.ok(boardCells.some((point, index) => index > 0 && point.y === boardCells[index - 1].y));
  assert.ok(boardCells.some((point, index) => index > 0 && point.x === boardCells[index - 1].x));
});

test('partial weeks keep weekday positions and do not create phantom food', () => {
  const input = calendar(2, () => true);
  input.weeks[0].contributionDays = input.weeks[0].contributionDays.slice(3);
  input.weeks[1].contributionDays = input.weeks[1].contributionDays.slice(0, 2);
  const result = simulate(input);
  assert.equal(result.cells.length, 6);
  assert.equal(result.finalLength, 6);
  assert.equal(result.eatenAt.has('0,0'), false);
  assert.equal(result.eatenAt.has('1,6'), false);
});

test('invalid input fails instead of publishing an empty or misleading animation', () => {
  for (const input of [null, {}, { weeks: [] }, { weeks: [{ contributionDays: [] }] }, calendar(55)]) {
    assert.throws(() => parseCalendar(input));
  }
  const duplicate = calendar(1);
  duplicate.weeks[0].contributionDays.push(duplicate.weeks[0].contributionDays[0]);
  assert.throws(() => parseCalendar(duplicate));
  const invalid = calendar(1);
  invalid.weeks[0].contributionDays[0].contributionCount = -1;
  assert.throws(() => parseCalendar(invalid));
});

test('compression preserves every interpolated position, including turns and pauses', () => {
  const result = simulate(calendar(8, (x, y) => (x + y) % 3 === 0));
  for (const [segment, birth] of result.births.entries()) {
    const points = result.frames.slice(birth).map((body, i) => ({ t: birth + i, ...body[segment] }));
    const compressed = simplify(points);
    for (const point of points) {
      const endIndex = compressed.findIndex((p) => p.t >= point.t);
      const end = compressed[endIndex];
      const start = compressed[Math.max(0, endIndex - 1)];
      const fraction = end.t === start.t ? 0 : (point.t - start.t) / (end.t - start.t);
      assert.ok(Math.abs(start.x + (end.x - start.x) * fraction - point.x) < 1e-9);
      assert.ok(Math.abs(start.y + (end.y - start.y) * fraction - point.y) < 1e-9);
    }
  }
});

test('SVG includes synchronized HUD, growth, food removal, themes, and reduced motion', () => {
  const result = simulate(calendar(2, () => true));
  for (const theme of ['light', 'dark']) {
    const svg = renderSvg(result, { theme, username: '<user & "name">' });
    assert.match(svg, /&lt;user &amp; &quot;name&quot;&gt;/);
    assert.equal((svg.match(/@keyframes travel/g) || []).length, 1);
    assert.equal((svg.match(/animation-name:travel/g) || []).length, 8);
    assert.equal((svg.match(/@keyframes birth-/g) || []).length, 4);
    assert.equal((svg.match(/@keyframes food-/g) || []).length, 14);
    assert.equal((svg.match(/@keyframes hud-/g) || []).length, 15);
    assert.match(svg, /class="hud"/);
    assert.match(svg, />SCORE</);
    assert.match(svg, />LEVEL</);
    assert.match(svg, />LENGTH</);
    assert.match(svg, />COMBO</);
    assert.match(svg, />1400</);
    assert.match(svg, />08</);
    assert.match(svg, />x4</);
    assert.match(svg, /y="58" width="12" height="12"/);
    assert.doesNotMatch(svg, /y="24" width="12" height="12"/);
    assert.match(svg, /prefers-reduced-motion:reduce/);
    assert.match(svg, /animation-iteration-count:infinite/);
    assert.match(svg, /animation-timing-function:steps\(1,end\)/);
    assert.doesNotMatch(svg, /NaN|undefined|<script/);
    for (const [eatenIndex, [cell, frame]] of [...result.eatenAt].entries()) {
      const foodTime = svg.match(new RegExp(`@keyframes food-${cell.replace(',', '-')}\\{0%\\{opacity:1\\}([\\d.]+)%`))[1];
      if ((eatenIndex + 1) % FOOD_PER_SEGMENT !== 0) continue;
      const index = result.births.indexOf(frame);
      const birthTime = svg.match(new RegExp(`@keyframes birth-${index}\\{0%\\{opacity:0\\}([\\d.]+)%`))[1];
      assert.equal(foodTime, birthTime);
    }
  }
});

test('maximum calendar SVG stays below 300 KB', () => {
  const svg = renderSvg(simulate(calendar(54, () => true)));
  assert.ok(Buffer.byteLength(svg) < 300_000, `${Buffer.byteLength(svg)} bytes`);
});

test('shared head trajectory with segment delay matches every visible body position', () => {
  for (const input of [calendar(54, () => true), calendar(53, (x, y) => (x + y) % 5 === 0)]) {
    const result = simulate(input);
    for (const [frame, body] of result.frames.entries()) {
      for (const [index, segment] of body.entries()) {
        if (segment.x < 0 || segment.x >= result.width || segment.y < 0 || segment.y >= 7) continue;
        assert.ok(frame >= index);
        assert.deepEqual(result.frames[frame - index][0], segment);
      }
    }
  }
});

test('GitHub request uses variables and checks HTTP, GraphQL, and missing-user errors', async () => {
  const input = calendar(2);
  const received = await fetchCalendar('example', 'test-token', async (url, options) => {
    assert.equal(url, 'https://api.github.com/graphql');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(options.body).variables, { login: 'example' });
    return { ok: true, json: async () => ({ data: { user: { contributionsCollection: { contributionCalendar: input } } } }) };
  });
  assert.deepEqual(received, input);
  await assert.rejects(fetchCalendar('', ''), /required/);
  await assert.rejects(fetchCalendar('example', 'token', async () => ({ ok: false, status: 403 })), /HTTP 403/);
  await assert.rejects(fetchCalendar('example', 'token', async () => ({ ok: true, json: async () => ({ errors: [{}] }) })), /GraphQL/);
  await assert.rejects(fetchCalendar('example', 'token', async () => ({ ok: true, json: async () => ({ data: { user: null } }) })), /not found/);
});
