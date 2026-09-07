# Growing contribution snake

The dependency-free Node.js 22 generator fetches the repository owner's GitHub
contribution calendar and creates light/dark SVGs for the profile README.

The snake starts with four segments. It gains one segment after eating three
**active contribution cells**, so growth is gradual instead of immediate. Empty
days do not count toward growth.
Like a real snake game, the snake selects contribution cells as food, finds paths
to them, avoids its own body, and follows its moving tail when a route is blocked.
A full-board route is used only as a safety fallback for extreme calendars. The
snake exits completely before the calendar resets. The animation uses SVG and
CSS; it needs no embedded script.
Reduced-motion preferences show the complete, static contribution calendar.

## Local checks

```sh
node --test scripts/generate-snake.test.mjs
```

To generate real data, set `GITHUB_USER` and `GITHUB_TOKEN` in the environment, then:

```sh
node scripts/generate-snake.mjs
```

For an offline preview, provide a JSON file containing a `contributionCalendar`
object, with `weeks[].contributionDays[]` entries containing `date`, `weekday`
(Sunday = 0), `contributionCount`, and `contributionLevel`:

```sh
node scripts/generate-snake.mjs --fixture calendar.json --out-dir dist
```

Open the generated SVG in a browser to see the animation. Fixture data is only
used when explicitly requested; API errors fail the workflow before publishing.
The workflow runs tests, generates both SVGs, then publishes `dist` to the existing
`output` branch on pushes to `main`, daily, or via **Run workflow** in Actions.
Generated files are ignored on the source branch.
