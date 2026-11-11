# highlights

A small self-hosted store for your reading highlights. It pulls the highlights you make in
[Readeck](https://readeck.org) (articles) and [BookOrbit](https://github.com/bookorbit/bookorbit) (books) into Postgres
(the passage, your note, colour, source, deep link, author and dates, never the article or book text) and gives one back each day over HTTP, so a daily note,
a widget or an LLM can use them.

## Run it

```sh
cp .env.example .env          # database password, plus Readeck and/or BookOrbit access (each source is optional)
docker compose up -d
curl http://localhost:8790/health
```

The image is `ghcr.io/christopher-nies/highlights:latest`, built and tested on every push to `main`.
Postgres data lives in `/srv/appdata/highlights/pgdata`; change the volume in `compose.yaml` if you keep it elsewhere.
Back it up as a dump (`pg_dump -Fc`), not by copying the data directory.

## API (GET only)

| Route | Returns |
|---|---|
| `/health` | `{ ok, live, lastIngest }` |
| `/today` | today's highlight (`?date=YYYY-MM-DD` for another day): the same one all day, least recently shown first; 204 when the store is empty |
| `/random` | any live highlight, not counted as shown |

The ingest runs at start and every `INGEST_MINUTES` (default 60). Each configured source runs on its own,
and one failing never blocks the other. It mirrors edits and deletions: a highlight deleted (or trashed) upstream
is marked deleted here and kept. BookOrbit lists only the logged-in user's own highlights, so log in as the reader
whose highlights you collect; a run is one login plus one request per 100 highlights, and never downloads books.

## CLI

```sh
docker compose exec app bun src/main.ts ingest          # import now
docker compose exec app bun src/main.ts today [date]    # that day's pick as JSON
docker compose exec app bun src/main.ts random          # a random one
```

## Obsidian daily note

Copy `obsidian/daily_highlight.js` into your Templater user-scripts folder and add to your daily template:

```
<% await tp.user.daily_highlight(tp, "http://your-host:8790") %>
```

It writes the day's highlight as a quote callout. When the service can't be reached (away from home,
for example) it writes nothing and the note is created as usual.

## Tests

`bun test` runs the unit tests. Set `TEST_DATABASE_URL` to a throwaway Postgres to run the store tests too;
they drop and recreate the tables.
