# dsh-astrbot-memory-bridge

DSH plugin bridge for connecting AstrBot multi-platform chat memory to a memory engine.

## What this version does

- Accepts AstrBot messages through a DSH HTTP route.
- Separates private chats and group chats.
- Separates contacts inside private chats.
- Separates group public memory and group-member memory.
- Keeps platform namespaces isolated by default.
- Supports optional cross-platform `person_id`.
- Forwards normalized memories to a configurable memory-engine HTTP API.
- Provides a recall endpoint for AstrBot to request relevant memories.

## Important

`dsh-memory-engine` v0.7.5 is published as a DSH plugin, but its public page currently does not document a stable external HTTP API. Therefore this bridge deliberately isolates the engine adapter in `HttpMemoryEngine`.

Before production use, replace `engine.ingestPath` / `engine.recallPath` with the actual API exposed by the exact dsh-memory-engine build you installed, or implement an in-process adapter.

## Install

```bash
dsh plugin --profile web add /path/to/dsh-astrbot-memory-bridge
dsh web
```

For a published package later:

```bash
dsh plugin --profile web add dsh-astrbot-memory-bridge
```

## Configuration

The bundle config defaults to:

```yaml
engine:
  mode: http
  baseUrl: http://127.0.0.1:8787
  ingestPath: /memory/ingest
  recallPath: /memory/recall
  apiKeyEnv: DSH_MEMORY_ENGINE_API_KEY
```

## AstrBot -> DSH ingest example

```json
{
  "platform": "qq",
  "conversation_type": "private",
  "conversation_id": "123456",
  "contact_id": "123456",
  "role": "user",
  "content": "我最近在做一个 Android 桌宠项目，名字叫 Yuyu。",
  "message_id": "msg-001",
  "category": "project",
  "importance": 0.9,
  "confidence": 0.95
}
```

Group member memory:

```json
{
  "platform": "qq",
  "conversation_type": "group",
  "conversation_id": "987654",
  "contact_id": "123456",
  "role": "user",
  "content": "我负责这个项目的服务器。",
  "category": "project",
  "importance": 0.85
}
```

Group public memory:

```json
{
  "platform": "qq",
  "conversation_type": "group",
  "conversation_id": "987654",
  "role": "user",
  "memory_scope": "group",
  "content": "这个项目下周开始测试。",
  "category": "event",
  "importance": 0.9
}
```

## Recall example

```json
{
  "platform": "qq",
  "conversation_type": "group",
  "conversation_id": "987654",
  "contact_id": "123456",
  "query": "之前那个项目什么时候测试？",
  "limit": 5
}
```

## Security

Do not expose the ingest/recall endpoints directly to the public Internet. Put them behind localhost, an authenticated reverse proxy, or the DSH web host's access controls.

## Next implementation step

The exact `dsh-memory-engine` API needs to be inspected from the installed package. The bridge is intentionally written so that only `HttpMemoryEngine` needs to change when the real engine contract is known.
