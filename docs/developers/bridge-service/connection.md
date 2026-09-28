# bridge-service: DLL Connection

This page describes the bridge's end of the named-pipe link to the game: connecting, framing messages, tracking responses, and recovering from disconnects. All of it is owned by the DLL connector in `bridge-service/src/services/dll-connector.ts`.

It is the mirror image of [civ5-dll/connection.md](../civ5-dll/connection.md). There the DLL is the **server** that creates the pipe and waits; here the bridge is the **sole client** that connects to it. The two share one wire format, so read them together. The exact message types that travel over the pipe stay in [message-types.md](../../../bridge-service/docs/message-types.md).

## The pipe

The bridge connects over a Windows named pipe using the `node-ipc` library, configured for raw-buffer mode with UTF-8 encoding. The pipe identifier comes from `gamepipe.id` (default `vox-deorum-bridge`). `node-ipc` adds its `tmp-app.` prefix, so the bridge dials `\\.\pipe\tmp-app.vox-deorum-bridge`.

The DLL builds its pipe name the same way, but from its own setting: the `VOX_DEORUM_PIPE_NAME` environment variable, which defaults to the same `vox-deorum-bridge`. These are two independent knobs that happen to share a default. Changing only one of them silently breaks the connection, and the bridge will sit in its reconnection loop forever without saying why. See [configuration.md](configuration.md) for how to keep them in step.

Only one client ever connects: the bridge. If the game is not yet running, the initial connection fails and the bridge falls into its [reconnection loop](#reconnection), waiting for the game and mod to load. After `node-ipc` reports a connection, the bridge waits a short settling delay before treating it as ready, because Windows named pipes need a moment to become fully usable.

## Message framing

Every message in either direction is a JSON object. Messages are separated on the wire by the literal delimiter `!@#$%^!`. A single pipe write can carry several messages joined by that delimiter, which is how the bridge batches calls (see [lua.md](lua.md)) to cut per-message overhead.

The pipe delivers a byte stream rather than discrete messages, so the connector keeps a running buffer of incoming bytes. As data arrives, it:

1. Appends the new bytes to the buffer.
2. Splits off every complete message up to a delimiter and handles it.
3. Keeps any trailing partial message in the buffer until the rest arrives.

The buffer is cleared whenever the connection drops, so a half-received message never bleeds into the next connection.

One rough edge is worth knowing: the DLL sometimes emits raw control characters inside JSON strings without properly escaping them. The connector sanitizes incoming text by escaping control characters before parsing, with a `TODO` to fix this on the DLL side. A message that still fails to parse is logged and dropped rather than crashing the connector.

## Sending and tracking responses

Outgoing traffic comes in three shapes:

- **Request/response calls** are sent with an identifier and tracked. The connector keeps a map of pending requests, each with its own timeout (600 seconds by default for Lua calls). When a `lua_response` arrives, the connector matches it to the pending request by id, settles it based on the response's `success` flag, and clears the timeout. A response whose id matches nothing pending is logged and ignored. Batches work the same way: every message in the batch gets its own id and pending entry, and the batch resolves once all of them have answered or timed out.
- **Fire-and-forget notifications** are sent without waiting for a reply, used for things like registering an external function or telling the DLL to pause a player. They return immediately: success, a disconnected error when the pipe is down, or a network error if the write itself throws.
- **Inbound messages that are not responses** (game events, registry notifications, external-call requests) match no pending request. The connector re-emits them as events named after their `type`, and the other services subscribe: the [Lua manager](lua.md) listens for registry changes, the [external manager](lua.md) listens for outbound-call requests, and the event routes listen for game events.

If the bridge tries to send while disconnected, the call fails fast with a `DLL_DISCONNECTED` error rather than blocking. See [error-handling.md](error-handling.md).

## Reconnection

The link is built to survive either side restarting, and the bridge never gives up on the game. When the connection drops unexpectedly, the connector:

1. Marks itself disconnected and clears its incoming buffer.
2. Immediately settles every pending request with `DLL_DISCONNECTED`, so no caller is left hanging.
3. Schedules a reconnection attempt.

Reconnection uses exponential backoff. The attempt counter is incremented before the delay is computed, so the first retry waits 300 ms; each subsequent delay grows by a factor of 1.5 up to a 5 second ceiling. Retries are infinite. None of these numbers are configurable, and none of them appear in `config.json`: they are literals in `dll-connector.ts`. Only one reconnection attempt is ever in flight at a time, and none are scheduled once a graceful shutdown has begun.

A successful reconnection emits a `connected` event, and two services use it to rebuild the state the DLL lost:

- The **external manager** re-registers every outbound function it knows about, so the game's Lua bindings come back.
- The **pause manager** re-enables production mode if it was on.

Auto-paused players are deliberately not replayed. The event routes clear the paused-player set the moment the connection drops, so a crash on either side cannot leave a player frozen with nobody left to un-freeze them. An agent that still wants a player paused re-registers it. Manual pause is unaffected by all of this, because the bridge holds that mutex itself. The three mechanisms are compared in [overview.md](overview.md).

## Graceful shutdown

A graceful shutdown is distinct from an unexpected drop, and it must not trigger a reconnect. The connector handles it in order:

1. Sets a shutting-down flag, which suppresses the reconnection loop.
2. Settles any remaining pending requests with a shutdown error.
3. Clears its reconnection timer and disconnects the pipe.
4. Waits up to 2 seconds for the disconnect to be acknowledged, then returns either way so shutdown cannot hang.

Because the flag is checked throughout, a disconnect during shutdown does not start a reconnect.

## The event pipe

Alongside the request/response pipe to the DLL, the bridge can run a second, outbound-only named pipe that broadcasts game events to local subscribers, an alternative to SSE for processes that prefer a pipe. It is implemented by `bridge-service/src/services/event-pipe.ts`, is off by default, and is enabled with `eventpipe.enabled` (see [configuration.md](configuration.md)).

On this pipe the bridge is the **server**: it listens and accepts any number of clients. A client that connects gets a welcome message addressed to it alone, not a broadcast, so existing subscribers see nothing when someone else joins. On shutdown the bridge broadcasts one goodbye to everybody. Events are batched on the same 50 ms and 100-event window the SSE stream uses, with DLL status changes flushed immediately. The transport is the same `node-ipc` raw-buffer mode and the same `!@#$%^!` delimiter as the DLL pipe, so a client buffers and splits incoming bytes exactly as the bridge does for the DLL. The wire format and a complete client example live in [event-pipe.md](../../../bridge-service/docs/event-pipe.md).

### When an event never arrives

If a game event you expected never reaches SSE or the event pipe, the bridge is usually not at fault. The DLL filters events before they are ever sent, and it reshapes the ones it does send. [message-types.md](../../../bridge-service/docs/message-types.md) is the authoritative list: it names the blacklist of high-frequency events that are dropped on purpose, notes that events without a schema or arguments are skipped, and explains the payload conventions that make a field look missing when it is not, namely arrays sent as a count plus items and schema fields with a `!` prefix converted from integers to booleans.

## See also

- [civ5-dll/connection.md](../civ5-dll/connection.md) is the server end of the same pipe. Keep it open alongside this page.
- [message-types.md](../../../bridge-service/docs/message-types.md) lists the exact JSON message types.
- [bridge-service/docs/protocol.md](../../../bridge-service/docs/protocol.md) has sequence diagrams for each flow.
- [protocol.md](../protocol.md) is the end-to-end narrative across all layers.
