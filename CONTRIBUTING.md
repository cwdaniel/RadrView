# Contributing to RadrView

Thanks for your interest in contributing! Here's how to get started.

## Reporting Bugs

Open an issue using the **Bug Report** template. Include:
- Steps to reproduce
- Expected vs actual behavior
- Docker logs (`docker logs radrview-server --tail 50`)
- Your OS and browser

## Requesting Features

Open an issue using the **Feature Request** template. Describe the problem you're trying to solve, not just the solution you want.

## Proposing New Data Sources

Open an issue using the **New Data Source** template. We're especially interested in:
- National weather services not yet covered
- Sources with public, free data access
- Sources with sub-10-minute update cadence

See [Adding a Source](docs/adding-a-source.md) for the technical guide.

## Pull Requests

1. Fork the repo
2. Create a branch from `main`
3. Make your changes
4. Ensure `npx tsc --noEmit` passes
5. Test with `docker compose -f docker/docker-compose.yml up -d --build`
6. Open a PR with the template filled out

### Code Guidelines

- TypeScript with strict mode
- ESM modules (`import`/`export`, not `require`)
- Use the existing logging pattern (`createLogger('name')`)
- Follow the existing ingester patterns (see `src/ingest/mrms.ts` or `src/nexrad/ingester.ts`)
- No unnecessary dependencies — prefer built-in Node.js APIs
- All internal tile values are dBZ encoded as single-channel grayscale bytes

### Architecture

- **Ingesters** run as separate Docker containers, communicate via Redis
- **Server** is lightweight — reads from Redis/MBTiles, renders tiles on demand
- **NEXRAD** data lives in Redis (written by ingester, read by server)
- **MRMS** data lives in MBTiles (written by tiler, read by server)

## Support the Project

If RadrView is useful to you, consider [making a donation](https://donate.stripe.com/3cI3cv9Vpew2fhf1AUcfK00).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
