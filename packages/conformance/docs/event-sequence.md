# Event Sequence

## Text-only run

`RUN_STARTED -> TEXT_START -> TEXT_DELTA* -> TEXT_END -> RUN_FINISHED`

## Server tool run

`RUN_STARTED -> TOOL_CALL_START -> TOOL_CALL_ARGS -> TOOL_CALL_END -> TOOL_RESULT -> RUN_FINISHED`

## Client tool run

`RUN_STARTED -> TOOL_CALL_START -> TOOL_CALL_ARGS -> TOOL_CALL_END -> RUN_FINISHED(awaiting_client_tool)`

Client submits `RunResumeRequest`

`TOOL_RESULT -> [TEXT_* and/or more tool events] -> RUN_FINISHED`

The same sequence applies to client-side MCP tools. The MCP connection is local to the client runtime, but the server still advertises the tool to the model through `RunStartRequest.clientTools` and pauses on the streamed tool call.
