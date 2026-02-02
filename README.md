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

## Running the Server with Docker

### Prerequisites

- Docker and Docker Compose installed
- `SERVER_SECRET` environment variable set (required for password hashing)

### Generating a Secure Server Secret

Generate a secure random secret for `SERVER_SECRET`:

**Linux/Mac:**

```bash
# Using openssl (recommended)
openssl rand -hex 32

# Alternative using /dev/urandom
head -c 32 /dev/urandom | base64
```

**Windows PowerShell:**

```powershell
# Generate 32 random bytes and convert to hex (recommended)
-join ((1..32 | ForEach-Object {Get-Random -Minimum 0 -Maximum 256}) | ForEach-Object {'{0:x2}' -f $_})

# Alternative: Generate base64 string
[Convert]::ToBase64String((1..32 | ForEach-Object {Get-Random -Minimum 0 -Maximum 256}))
```

**Windows CMD (using PowerShell):**

```cmd
powershell -Command "[Convert]::ToBase64String((1..32 | ForEach-Object {Get-Random -Minimum 0 -Maximum 256}))"
```

### Starting the Server

1. **Set the required environment variable:**

   ```bash
   # On Linux/Mac
   export SERVER_SECRET=your-secret-key-here

   # On Windows PowerShell
   $env:SERVER_SECRET="your-secret-key-here"

   # On Windows CMD
   set SERVER_SECRET=your-secret-key-here
   ```

   Or create a `.env` file in the `server/` directory:

   ```
   SERVER_SECRET=your-secret-key-here
   ```

2. **Start the server:**

   ```bash
   cd server
   docker-compose up
   ```

   Or build and start in detached mode:

   ```bash
   cd server
   docker-compose up -d --build
   ```

3. **Verify the server is running:**

   ```bash
   curl http://localhost:8080/healthz
   ```

   Expected response: `{"status":"ok"}`

### Stopping the Server

```bash
cd server
docker-compose down
```

### Viewing Logs

```bash
cd server
docker-compose logs -f
```

### Configuration

The server can be configured via environment variables in `docker-compose.yml`. Key settings:

- `PORT` - HTTP server port (default: 8080)
- `LOG_LEVEL` - Logging level: 'error', 'warn', 'info', 'debug' (default: 'info')
- `ROOM_TTL_SECONDS` - Room expiration time in seconds (default: 86400 = 24h)
- `SERVER_SECRET` - Required secret key for password hashing

See `server/src/config.ts` for all available configuration options.

## Architecture

- **Single container design**: HTTP dashboard + WebSocket sync in one Node.js process
- **Minimal dependencies**: No DB, no Redis - all state in-memory
- **JSON message protocol**: All WebSocket messages are JSON with server-side validation
- **Structured logging**: Uses `pino` for all logging
