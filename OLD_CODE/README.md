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

### Development Environment

The development environment includes hot reloading - code changes are automatically detected and the server restarts.

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

2. **Start the development server:**

   ```bash
   cd server
   docker-compose up playbacksync-dev
   ```

   Or build and start in detached mode:

   ```bash
   cd server
   docker-compose up -d --build playbacksync-dev
   ```

3. **Verify the server is running:**

   ```bash
   curl http://localhost:8080/healthz
   ```

   Expected response: `{"status":"ok"}`

**Features:**

- Hot reloading enabled (changes to `src/` automatically restart the server)
- Source code mounted as volume for live editing
- Development dependencies included
- Uses `nodemon` with polling for reliable file watching in Docker

**Viewing logs:**

```bash
cd server
docker-compose logs -f playbacksync-dev
```

**Stopping the development server:**

```bash
cd server
docker-compose stop playbacksync-dev
```

### Production Environment

The production environment uses an optimized multi-stage build with compiled TypeScript.

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

2. **Start the production server:**

   ```bash
   cd server
   docker-compose up playbacksync
   ```

   Or build and start in detached mode:

   ```bash
   cd server
   docker-compose up -d --build playbacksync
   ```

3. **Verify the server is running:**

   ```bash
   curl http://localhost:8080/healthz
   ```

   Expected response: `{"status":"ok"}`

**Features:**

- Optimized multi-stage Docker build
- Production dependencies only (smaller image size)
- Pre-compiled TypeScript for faster startup
- Health checks enabled

**Viewing logs:**

```bash
cd server
docker-compose logs -f playbacksync
```

**Stopping the production server:**

```bash
cd server
docker-compose stop playbacksync
```

### Stopping All Services

To stop both development and production services:

```bash
cd server
docker-compose down
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
