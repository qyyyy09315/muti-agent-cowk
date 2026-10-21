# 学术风格流程图的生成记录

日期：2026-10-21。使用内置 `image_gen` 绘图工具生成PNG，未调用外部付费API或本地CLI绘图后端。三张图均人工核对节点名、箭头方向和代码语义，原图以相对路径随仓库保存。图2有意简化部分异常转移，权威规则仍是契约代码。编辑时应优先修改下列提示词并重新生成，再与代码核对，避免只凭图更新实现。

## 通用提示词（每张图均使用）

Create a publication-quality academic systems diagram for a software engineering paper and GitHub README. Wide landscape, crisp black typography, white background, thin dark-gray orthogonal arrows, flat rectangular boxes with subtle small corner radius, generous whitespace, restrained color-blind-friendly pale blue #E6EEF5, teal #E4F1EB, sand #F5EDDC, grayscale readable. No gradients, shadows, emojis, 3D, decorative illustrations or invented performance claims. English labels only, exactly as specified. High resolution, legible at 1000px width.

## system-architecture.png

Title 'System Architecture'. Left shaded group 'Edge Host A' containing 'Worker A', 'Local CLI agent', 'Isolated Unity workspace'; Worker A points to Local CLI agent which points to workspace. Center shaded group 'Control Plane' containing 'REST / SSE / MCP', 'Scheduler', 'PostgreSQL', 'Web Console'; Scheduler bidirectional PostgreSQL; REST bidirectional Scheduler; Web Console bidirectional REST. Right group 'Edge Host B' containing analogous Worker B, Local CLI agent, Isolated Unity workspace. Worker A and Worker B connect bidirectionally to the central REST box, labelled 'Tasks / leases / messages'. Bottom shared 'UVCS Repository' connected from both isolated workspaces labelled 'Validated changesets'. Small footer 'Model credentials remain on edge hosts'. Show human reviewer above Web Console connected to it, label 'Human review'. Align all elements precisely. Do not show direct agent-to-agent arrows bypassing Hub.

## task-lifecycle.png

Title 'Task Lifecycle (Simplified)'. Main horizontal row of six boxes, exact labels: 'queued', 'leased', 'running', 'submitted', 'reviewing', 'completed', arrows left to right. Add a small shortcut arrow from leased to submitted labelled 'Direct submission'. Below reviewing put 'needs_changes' with reviewing -> needs_changes labelled 'Revision' and dashed feedback from needs_changes to queued labelled 'New repair attempt'. Below running two separate boxes 'waiting_peer' and 'waiting_human', with bidirectional arrows to running labelled 'Clarification' and 'Human decision'. Bottom left 'paused' with queued -> paused -> queued. Bottom right separate terminal boxes 'failed' and 'cancelled', grouped in a thin dashed rectangle labelled 'Terminal outcomes'. Do not connect failed or cancelled back to active states. Small footer 'Selected transitions shown; the contract transition table is authoritative'. Keep arrows uncluttered using separated horizontal channels. All 12 states appear exactly once.

## peer-coordination.png

Title 'Peer Coordination and Progress Reporting'. Draw sequence diagram with three vertical swimlanes 'Worker A', 'Hub', 'Worker B'. Upper section labelled 'Task clarification': arrow A->Hub '1. Ask (taskId, threadId)'; Hub->B '2. message_sent'; small box in B lane 'Generate reply locally'; B->Hub '3. Reply (replyToId)'; Hub->A '4. Deliver canonical reply'. Lower section separated by thin rule labelled 'In-run progress discussion': A->Hub 'Milestone / question (progress:runId)'; Hub->B 'Progress event'; B->Hub 'Advice / review reply'; Hub->A 'Return to the same task context'. Thin annotation adjacent Hub 'Progress threads preserve the current lease'. Footer 'Stable idempotency keys + persistent outbox; no reply-to-reply loop'. A small dashed feedback arrow from bottom A back to its execution lane label 'Continue original task'. Do not show a progress message requeueing the task, and do not imply an acknowledgment is approval.
