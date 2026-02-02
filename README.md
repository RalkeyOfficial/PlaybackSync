# PlaybackSync

Synchronized video playback across multiple clients.

## Project Structure

- `server/` - Node.js server with HTTP dashboard and WebSocket sync
- `extension/` - Browser extension for video synchronization

## Development

```bash
# Install dependencies
npm install

# Build all workspaces
npm run build

# Run tests
npm run test

# Format code
npm run format

# Check formatting
npm run format:check
```

## Architecture

- **Single container design**: HTTP dashboard + WebSocket sync in one Node.js process
- **Minimal dependencies**: No DB, no Redis - all state in-memory
- **JSON message protocol**: All WebSocket messages are JSON with server-side validation
- **Structured logging**: Uses `pino` for all logging
