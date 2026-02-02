# PlaybackSync Server Implementation Plan

This document outlines a step-by-step implementation plan for the PlaybackSync server, progressing from basic infrastructure to advanced features.

---

## Phase 1: Foundation & Infrastructure

### Step 1.1: Docker Setup and Basic Server Structure
**Goal**: Establish containerization and basic server skeleton

**Tasks**:
- Create `Dockerfile` using `node:20-alpine` base image
- Create `docker-compose.yml` with environment variables
- Set up multi-stage build for TypeScript compilation
- Create basic server entry point that starts Fastify HTTP server
- Configure environment variable loading (PORT, LOG_LEVEL, etc.)
- Set up basic project structure (`src/` directories for routes, handlers, types, etc.)

**Verification**:
- ✅ `docker-compose up` starts container successfully
- ✅ Server responds to HTTP requests on configured PORT
- ✅ Container logs show server startup messages
- ✅ Health check endpoint `/healthz` returns 200
- ✅ TypeScript compiles without errors

**Acceptance Criteria**:
- Container builds and runs without errors
- Server listens on configured port
- Basic HTTP request/response works

---

### Step 1.2: Structured Logging Setup
**Goal**: Implement pino-based structured logging throughout the application

**Tasks**:
- Configure pino logger with environment-based log levels
- Set up pino-pretty for development
- Create logging utility module with helper functions
- Implement anonymization helpers (maskId, redactIP)
- Add structured logging to server startup/shutdown
- Configure log format based on NODE_ENV (pretty in dev, JSON in prod)

**Verification**:
- ✅ Logs appear in structured JSON format in production mode
- ✅ Logs are human-readable in development mode
- ✅ Log levels respect LOG_LEVEL environment variable
- ✅ Sensitive data (clientId, IPs) are masked when ANON_LOGGING=true
- ✅ Logs include context (roomId, clientId, event type)

**Acceptance Criteria**:
- All console.log statements replaced with structured logger calls
- Logs follow project standards (structured, contextual, anonymized)

---

### Step 1.3: Type Definitions and Core Interfaces
**Goal**: Define TypeScript types for all data structures

**Tasks**:
- Create `src/types/` directory structure
- Define `Room` interface with all properties (roomId, passwordHash, state, connectedClients, etc.)
- Define `ClientConnection` interface
- Define `RecentEvent` interface for event log
- Create branded types for `roomId` and `clientId` (UUID strings)
- Define message type interfaces (JOIN, EVENT, STATE, COMMAND, ERROR, etc.)
- Create configuration interface for environment variables

**Verification**:
- ✅ TypeScript compilation succeeds with strict mode
- ✅ All interfaces match design document specifications
- ✅ Branded types prevent mixing roomId/clientId
- ✅ No `any` types used

**Acceptance Criteria**:
- Complete type coverage for all data structures
- Type safety enforced throughout codebase

---

## Phase 2: HTTP Server & Admin API

### Step 2.1: Basic HTTP Endpoints
**Goal**: Implement core HTTP endpoints for health and metrics

**Tasks**:
- Set up Fastify plugins structure
- Implement `/healthz` endpoint with basic health checks
- Set up Prometheus metrics client (prom-client)
- Implement `/metrics` endpoint returning Prometheus format
- Add basic metrics (process memory, CPU, uptime)
- Configure Fastify JSON schema validation

**Verification**:
- ✅ `GET /healthz` returns 200 with health status
- ✅ `GET /metrics` returns Prometheus-formatted metrics
- ✅ Metrics include basic process information
- ✅ Endpoints handle errors gracefully

**Acceptance Criteria**:
- Health check endpoint functional
- Metrics endpoint exposes basic system metrics

---

### Step 2.2: Room Management API (Create & List)
**Goal**: Implement room creation and listing endpoints

**Tasks**:
- Create in-memory `Map<roomId, Room>` storage
- Implement `POST /api/rooms` endpoint
  - Generate UUID v4 for roomId
  - Generate random password
  - Hash password using HMAC with server secret
  - Create Room object with TTL
  - Return roomId, password, share link
- Implement `GET /api/rooms` endpoint
  - Return list of active rooms (id, createdAt, participantCount, last_state)
  - Filter expired rooms
- Add JSON schema validation for request bodies
- Implement password hashing utility (HMAC-SHA256)

**Verification**:
- ✅ `POST /api/rooms` creates room and returns credentials
- ✅ Created room appears in `GET /api/rooms` list
- ✅ Room expiration works (rooms expire after TTL)
- ✅ Password is hashed, never stored in plaintext
- ✅ Request validation rejects invalid input
- ✅ Share link format is correct

**Acceptance Criteria**:
- Rooms can be created via API
- Room list endpoint shows active rooms
- Password security implemented correctly

---

### Step 2.3: Room Management API (Details & Revocation)
**Goal**: Complete room management with detail view and deletion

**Tasks**:
- Implement `GET /api/rooms/:roomId` endpoint
  - Return room details (state, connected clients, recent events)
  - Return 404 if room doesn't exist
- Implement `DELETE /api/rooms/:roomId` endpoint
  - Close all WebSocket connections in room
  - Remove room from storage
  - Return success response
- Add error handling for invalid roomId format
- Implement room cleanup background task (remove expired rooms periodically)

**Verification**:
- ✅ `GET /api/rooms/:roomId` returns correct room details
- ✅ `DELETE /api/rooms/:roomId` removes room and closes connections
- ✅ Expired rooms are cleaned up automatically
- ✅ Invalid roomId returns appropriate error (400/404)
- ✅ Room state includes all required fields

**Acceptance Criteria**:
- Complete CRUD operations for rooms via HTTP API
- Room lifecycle management works correctly

---

## Phase 3: WebSocket Foundation

### Step 3.1: WebSocket Server Setup
**Goal**: Establish WebSocket server and connection handling

**Tasks**:
- Integrate `ws` library with Fastify server
- Set up WebSocket upgrade handler
- Create WebSocket connection manager
- Implement connection metadata storage (attach roomId, clientId to ws object)
- Set up connection event handlers (open, message, close, error)
- Implement connection timeout (close if no JOIN within 5s)

**Verification**:
- ✅ WebSocket server accepts connections
- ✅ Connections timeout if no JOIN message received
- ✅ Connection metadata is stored correctly
- ✅ Connection close events are handled
- ✅ Multiple concurrent connections work

**Acceptance Criteria**:
- WebSocket server functional and integrated with HTTP server
- Basic connection lifecycle works

---

### Step 3.2: JSON Schema Validation Setup
**Goal**: Implement message validation using ajv

**Tasks**:
- Create `schemas/` directory for JSON schemas
- Define JSON schemas for all message types:
  - JOIN schema
  - EVENT schema
  - EPISODE_CHANGE_REQUEST schema
  - TIME_REPORT schema
  - STATE schema
  - COMMAND schema
  - ERROR schema
- Create schema validation utility module
- Implement message validator using ajv
- Add validation error formatting

**Verification**:
- ✅ All message schemas defined and valid
- ✅ Valid messages pass validation
- ✅ Invalid messages are rejected with clear errors
- ✅ Schema validation is fast (< 1ms per message)
- ✅ Validation errors include helpful messages

**Acceptance Criteria**:
- Complete JSON schema coverage for all message types
- Validation integrated into message handling pipeline

---

### Step 3.3: JOIN Message Handling
**Goal**: Implement room authentication and client registration

**Tasks**:
- Implement JOIN message handler
  - Validate JOIN message schema
  - Look up room by roomId
  - Verify password hash matches
  - Check for client tombstone (reconnection)
  - Add client to room.connectedClients
  - Send current STATE to joining client
  - Log join event with structured logging
- Handle authentication failures (send ERROR, close connection)
- Handle room not found (send ERROR, close connection)
- Handle tombstone reconnection (reattach existing clientId)

**Verification**:
- ✅ Valid JOIN with correct credentials succeeds
- ✅ Invalid password sends ERROR and closes connection
- ✅ Non-existent room sends ERROR and closes connection
- ✅ Joining client receives current STATE immediately
- ✅ Reconnection with same clientId uses tombstone
- ✅ Multiple clients can join same room
- ✅ Join events are logged correctly

**Acceptance Criteria**:
- JOIN authentication works correctly
- Client registration and state sync functional

---

## Phase 4: Core Synchronization Logic

### Step 4.1: Basic Event Handling (Play/Pause/Seek)
**Goal**: Implement explicit control event processing

**Tasks**:
- Implement EVENT message handler
  - Validate EVENT message schema
  - Check rate limits (per connection)
  - Update room.state immediately (paused, time)
  - Append to room.eventLog (ring buffer)
  - Update last_explicit_event_ts
  - Update last_state_update_ts
  - Broadcast STATE to all connected clients
- Handle play, pause, and seek event types
- Implement rate limiting (token bucket or rate-limiter-flexible)
- Add rate limit error responses

**Verification**:
- ✅ Play event updates state and broadcasts to all clients
- ✅ Pause event updates state and broadcasts to all clients
- ✅ Seek event updates time and broadcasts to all clients
- ✅ Rate limiting prevents message flooding
- ✅ Rate limit exceeded returns ERROR message
- ✅ Event log maintains last N events
- ✅ All clients receive STATE updates

**Acceptance Criteria**:
- Basic playback control events work end-to-end
- Rate limiting prevents abuse

---

### Step 4.2: Episode Change Handling
**Goal**: Implement episode change synchronization

**Tasks**:
- Implement EPISODE_CHANGE_REQUEST handler
  - Validate message schema
  - Derive derivedContentKey from URL + provider + episode
  - Increment eventId
  - Reset playback state (paused=true, videoPos=0)
  - Update room state with new episode info
  - Broadcast EPISODE_CHANGE to all clients
- Handle content mismatch detection
- Send CONTENT_MISMATCH advisory when needed
- Update room state with episode metadata

**Verification**:
- ✅ Episode change request updates room state
- ✅ Episode change broadcasts to all clients
- ✅ Playback state resets on episode change
- ✅ Content mismatch detection works
- ✅ derivedContentKey is computed correctly
- ✅ Multiple episode changes handled correctly

**Acceptance Criteria**:
- Episode changes are synchronized across clients
- Content identity validation works

---

### Step 4.3: State Broadcasting and Message Routing
**Goal**: Implement robust message routing and broadcasting

**Tasks**:
- Create message router/dispatcher
- Implement STATE message construction
  - Include paused, time, provider, episode
  - Include server_ts (monotonic timestamp)
  - Include eventId for ordering
- Implement COMMAND message construction
- Implement ERROR message construction
- Create broadcast utility (handle closed connections gracefully)
- Add message queuing for slow clients (optional)

**Verification**:
- ✅ STATE messages include all required fields
- ✅ Broadcasts reach all connected clients
- ✅ Closed connections are handled gracefully (no errors)
- ✅ Server timestamps are monotonic
- ✅ Message ordering is preserved
- ✅ Error messages are formatted correctly

**Acceptance Criteria**:
- Reliable message broadcasting
- Proper error handling for connection issues

---

## Phase 5: Advanced Features

### Step 5.1: Drift Reconciliation System
**Goal**: Implement automatic time drift detection and correction

**Tasks**:
- Implement expected playback time calculation
  - If paused: expected_time = state.time
  - If playing: expected_time = state.time + (now - last_state_update_ts)
- Create periodic drift check task (every DRIFT_CHECK_INTERVAL_MS)
- Implement drift reconciliation algorithm:
  - Skip if within COOLDOWN_WINDOW_MS after explicit event
  - Request TIME_REPORT from all clients
  - Calculate delta for each client
  - If any client exceeds DRIFT_THRESHOLD_MS, broadcast STATE with expected_time
- Handle TIME_REPORT messages from clients
- Add metrics for reconciliation runs

**Verification**:
- ✅ Expected time calculation is correct
- ✅ Drift checks run on schedule
- ✅ Cooldown window prevents reconciliation after explicit events
- ✅ Clients exceeding threshold receive correction
- ✅ Reconciliation doesn't interfere with explicit control
- ✅ Metrics track reconciliation activity

**Acceptance Criteria**:
- Automatic drift correction works
- Doesn't interfere with user control

---

### Step 5.2: Client Reconnection & Tombstone Logic
**Goal**: Implement graceful reconnection handling

**Tasks**:
- Implement tombstone creation on disconnect
  - Set tombstonedUntil = now + CLIENT_TOMBSTONE_MS
  - Remove connection but keep metadata
- Enhance JOIN handler to check for tombstones
  - If clientId has valid tombstone, reattach connection
  - Preserve client state/history
- Implement connection cleanup
  - Remove expired tombstones
  - Clean up disconnected clients
- Handle rapid reconnect scenarios

**Verification**:
- ✅ Disconnected clients get tombstones
- ✅ Reconnection within window reattaches same clientId
- ✅ Reconnection after tombstone expiry creates new client
- ✅ Client state preserved on reconnection
- ✅ Expired tombstones are cleaned up
- ✅ Rapid reconnects work correctly

**Acceptance Criteria**:
- Seamless reconnection experience
- Client identity preserved during network issues

---

### Step 5.3: Rate Limiting & Abuse Protection
**Goal**: Implement comprehensive rate limiting

**Tasks**:
- Implement per-connection rate limiter for explicit events
- Add global per-room rate limiting
- Implement message size validation
- Add connection count limits per room
- Implement flood protection for broadcasts
- Add rate limit metrics

**Verification**:
- ✅ Per-connection rate limits enforced
- ✅ Room-level rate limits prevent flooding
- ✅ Large messages are rejected
- ✅ Connection limits prevent resource exhaustion
- ✅ Rate limit violations are logged
- ✅ Metrics track rate limiting activity

**Acceptance Criteria**:
- Server protected from abuse
- Rate limits are configurable and effective

---

## Phase 6: Observability & Operations

### Step 6.1: Prometheus Metrics
**Goal**: Expose comprehensive metrics for monitoring

**Tasks**:
- Add gauge metrics:
  - `playbacksync_rooms_total`
  - `playbacksync_connections_total`
- Add counter metrics:
  - `playbacksync_events_total` (with labels: eventType, roomId)
  - `playbacksync_reconciliation_runs_total`
  - `playbacksync_rate_limited_total`
- Add histogram metrics for message processing latency
- Update metrics on relevant events
- Ensure metrics endpoint is performant

**Verification**:
- ✅ All metrics are exposed on `/metrics`
- ✅ Metrics update correctly on events
- ✅ Metric labels are appropriate
- ✅ Metrics follow naming convention (playbacksync_*)
- ✅ Metrics endpoint is fast (< 10ms)

**Acceptance Criteria**:
- Complete metrics coverage for monitoring
- Metrics follow Prometheus best practices

---

### Step 6.2: Enhanced Logging & Audit Trail
**Goal**: Implement comprehensive logging and audit capabilities

**Tasks**:
- Add structured logging for all major events:
  - Room creation/deletion
  - Client join/leave
  - Event processing
  - Reconciliation runs
  - Rate limit violations
- Implement audit buffer (recent events per room)
- Add log context propagation (roomId, clientId)
- Ensure sensitive data is never logged
- Add log rotation guidance

**Verification**:
- ✅ All events are logged with context
- ✅ Sensitive data is never logged
- ✅ Logs are structured and parseable
- ✅ Audit buffer maintains recent events
- ✅ Log levels are appropriate

**Acceptance Criteria**:
- Complete audit trail for debugging
- Logging follows project standards

---

### Step 6.3: Graceful Shutdown
**Goal**: Implement clean server shutdown

**Tasks**:
- Implement SIGTERM/SIGINT handlers
- Stop accepting new connections on shutdown
- Send SERVER_SHUTDOWN notice to connected clients
- Wait up to 5s for graceful close
- Force close remaining connections after timeout
- Clean up resources (close servers, clear timers)
- Log shutdown events

**Verification**:
- ✅ Server handles SIGTERM gracefully
- ✅ Clients receive shutdown notice
- ✅ Connections close cleanly
- ✅ No resource leaks on shutdown
- ✅ Shutdown completes within timeout
- ✅ Logs show shutdown process

**Acceptance Criteria**:
- Clean shutdown without data loss
- Clients notified of shutdown

---

## Phase 7: Testing & Quality Assurance

### Step 7.1: Unit Tests for Core Logic
**Goal**: Test individual components in isolation

**Tasks**:
- Set up Jest test framework
- Write tests for:
  - Message validation (JSON schemas)
  - Password hashing/verification
  - Expected time calculation
  - Drift reconciliation logic
  - Rate limiter
  - Room state management
- Achieve >80% code coverage for core logic

**Verification**:
- ✅ All unit tests pass
- ✅ Code coverage meets threshold
- ✅ Tests are fast (< 1s total)
- ✅ Tests are isolated and repeatable

**Acceptance Criteria**:
- Core logic is thoroughly tested
- Tests serve as documentation

---

### Step 7.2: Integration Test Harness
**Goal**: Test end-to-end scenarios with multiple clients

**Tasks**:
- Create `scripts/test-harness.js` test client
- Implement scenarios:
  - Multiple clients join room
  - Client A sends seek, verify B/C receive STATE
  - Simulate network disconnect/reconnect
  - Test tombstone reattachment
  - Test episode change synchronization
  - Test drift reconciliation
- Run harness against Docker container
- Add CI/CD integration

**Verification**:
- ✅ Test harness runs successfully
- ✅ All scenarios pass
- ✅ Harness can simulate 3+ concurrent clients
- ✅ Tests run against Docker container
- ✅ Results are reproducible

**Acceptance Criteria**:
- End-to-end functionality verified
- Test harness usable for regression testing

---

### Step 7.3: Load Testing & Performance Validation
**Goal**: Validate performance under expected load

**Tasks**:
- Create load test scenarios (1 room, 3 clients)
- Measure:
  - Message latency (p50, p95, p99)
  - Memory usage
  - CPU usage
  - Connection handling
- Validate resource estimates (50-150MB RAM, <0.2 CPU)
- Test edge cases (rapid events, many rooms)

**Verification**:
- ✅ Performance meets requirements
- ✅ Resource usage within estimates
- ✅ No memory leaks under load
- ✅ Latency acceptable (< 100ms p95)

**Acceptance Criteria**:
- System performs within specifications
- No performance regressions

---

## Phase 8: Documentation & Deployment

### Step 8.1: API Documentation
**Goal**: Document all HTTP and WebSocket APIs

**Tasks**:
- Document HTTP API endpoints (request/response formats)
- Document WebSocket message protocol
- Create example requests/responses
- Document error codes and meanings
- Add OpenAPI/Swagger spec (optional)

**Verification**:
- ✅ All endpoints documented
- ✅ Examples are accurate
- ✅ Error codes explained
- ✅ Documentation is clear and complete

**Acceptance Criteria**:
- Complete API documentation
- Easy for developers to integrate

---

### Step 8.2: Deployment Documentation
**Goal**: Provide deployment and operational guidance

**Tasks**:
- Document Docker deployment steps
- Document environment variables
- Create example docker-compose.yml
- Document Traefik integration
- Add monitoring/alerting recommendations
- Document troubleshooting guide

**Verification**:
- ✅ Deployment steps are clear
- ✅ All configuration options documented
- ✅ Examples work out of the box
- ✅ Troubleshooting guide is helpful

**Acceptance Criteria**:
- Complete deployment documentation
- Operators can deploy confidently

---

## Verification Checklist Summary

After completing each phase, verify:

- [ ] Code follows project standards (TypeScript strict, structured logging, no console.log)
- [ ] All environment variables are documented and have defaults
- [ ] Error handling is comprehensive
- [ ] Logging includes appropriate context
- [ ] No sensitive data in logs
- [ ] Metrics are exposed correctly
- [ ] Docker container builds and runs
- [ ] Tests pass
- [ ] Documentation is updated

---

## Notes

- Each step builds on previous steps
- Verification steps should be completed before moving to next step
- Some steps can be worked on in parallel (e.g., logging setup while building HTTP endpoints)
- Focus on correctness before optimization
- Follow the project standards document for code style and patterns
