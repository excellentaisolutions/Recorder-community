---
name: recorder-control
description: Control Recorder for Windows through MCP or JSON CLI to capture screens, windows and regions, run repeatable browser demos, and compose narrated videos. Use for recording and audiovisual demo requests involving Recorder; no computer use is needed to operate Recorder.
---

# Recorder control

Recorder must be running in an interactive Windows session with Integraciones IA enabled. The panel provides the exact MCP configuration, including executable, entrypoint and connection path. Keep ELECTRON_RUN_AS_NODE=1 for the MCP adapter on Windows. Do not expose the local connection file or its token in output. An agent running only in the cloud cannot reach this local service by itself.

Discover the actual tools rather than inventing parameters. MCP names use underscores (`recording_start`); CLI methods use dots (`recording.start`). The portable CLI is `Recorder.exe --cli METHOD --file arguments.json`. Use structured files for arguments, not interpolated shell strings. `Recorder.exe --cli tools` returns the schemas. Set a distinct RECORDER_CLIENT for each independently controlling agent; this is a session label, not a separate security boundary.

## Recording

- Call capabilities_get first to discover monitors (including negative DIP positions and scale), installed demo browsers, supported methods and explicit limitations. Refresh sources_list after topology or window changes. devices_list gives camera/capture-card and microphone ids for this profile.
- Use settings_get/update for persistent preferences while idle. Updates preserve unspecified fields; they do not change access credentials or output directory. schedule_create accepts an ISO at with timezone and a capture object, within 24 days. Poll its job for the started session id; jobs_cancel cancels a pending schedule. Recorder must remain open; schedules are cancelled by exit/revocation.

- Use sources_list and source_preview to choose a source by its returned id. Thumbnails do not define full-resolution window geometry. Regions are normalized to the selected source, with x/y/width/height between 0 and 1. recording_status returns actual dimensions after capture starts.
- recording_start returns when capture is recording. Retain its id as sessionId. autoStop is active recording seconds; pauses do not count. 0 is unlimited. Explicitly choose audio sources; agent calls default to audio off.
- Use recording_pause/resume/mark and screenshot_capture with sessionId. A screenshot during a recording uses the current composition. UI controls can stop an agent session as an emergency override.
- recording_stop returns a jobId. Poll jobs_status until completed, failed or cancelled. A successful request is not proof the export completed. Deliver the artifact only after completion. Mark metadata is saved beside recordings as .session.json.
- On transport failure, inspect recording_status before retrying a start. The CLI supports --request-id UUID for exact retries within the running application's bounded cache. Do not restart a live session blindly.

For multiple native monitors or application/browser windows, use recording_start or screenshot_capture with mode scene and scene {layout,width,height,items:[{sourceId,label,region?},...]}. Supply two to four distinct current source ids. Layout is horizontal, vertical or grid; dimensions are even, up to 3840x2160. Regions crop each source in normalized coordinates. System audio is mixed once, not once per panel. A scene exports one combined recording and preserves aspect ratios; closing a source ends the recording. It is different from two isolated Playwright contexts. Do not claim physical multi-monitor/DPI validation from a synthetic metadata test, or universal support for protected/minimized windows.

## Web demos

demo_run opens a separate Edge/Chrome session and records its viewport. It does not capture desktop windows or system audio. Existing browser logins are not reused. Prepare demo accounts and explicit actions appropriate to the user's request.

Recipes accept url, browser (msedge/chrome), width, height, format and steps. Actions: click, fill, wait, expectText, hold, mark, frame, screenshot. Targets use role/name (exact), testId, or selector. Prefer roles and test ids. A frame action records a normalized rectangle for a visible element; it is an editing marker, not a live camera move. A screenshot may target an element. Supply no JavaScript: there is no eval operation.

Example steps:
```json
[
  {"action":"fill","target":{"role":"textbox","name":"Nombre"},"value":"Cliente Demo"},
  {"action":"click","target":{"role":"button","name":"Crear cliente"}},
  {"action":"expectText","target":{"role":"status"},"text":"Cliente creado"},
  {"action":"frame","target":{"role":"status"},"label":"Resultado"},
  {"action":"hold","milliseconds":1500}
]
```

Poll the returned job. A failed step reports its index and preserves a partial recording when available. Check whether the target software changed before retrying; do not repeat non-idempotent business actions automatically. jobs_cancel cancels demos/montages/narration. Recording exports finish to preserve media.

## Two-session demos

Use demo_multiview for customer/admin or two-role demos. Supply exactly two views [{id,label,url,setup?}], per-view width/height, layout (horizontal/vertical) and steps. Each ordinary step requires view: the view id. A parallel step contains two ordinary steps targeting different views. Both browser contexts have isolated cookies and storage, even on the same domain. setup actions run before recording, for example separate sign-ins. No second monitor is required.

Wait for both recordings before executing the common script. The tool does this internally, aligns by browser frame timestamps and returns a combined MP4, the two original WebMs, per-view markers and timing metadata. It is coordinated browser capture, not guaranteed frame-perfect broadcast synchronization. Each view gets a 40px label strip. width/height refer to each viewport, not final output.

For close-ups use a marker's region with that view's original file, or its compositeRegion with the combined MP4. Mixing these coordinate spaces crops the wrong area. These recordings have no system audio; add local narration through media_compose if needed. Treat both partial originals as recoverable material when a step fails.

## Production

voices_list exposes installed Windows voices. narration_create produces local WAV with text, optional voice and rate (-5..5). Quality/language depend on installed voices; this is local synthesis, not voice cloning.

media_compose takes clips [{file,start,duration,region?,title?}], width/height, branding (default false: stamps the Recorder icon), optional narration and subtitles [{start,end,text}]. All source files must belong to Recorder's output folder. It trims/crops/scales to a new MP4 and preserves originals. Clip duration is capped at remaining source duration. Audio is preserved; with narration, original audio is reduced to 25% and mixed with the voice. Subtitles are supplied text/timing, not automatic transcription.

Use recorded frame regions to make close-up clips. Sequence wide/close-up clips for demonstrations. Montage supports cuts, not animated zoom transitions. Verify the rendered file and representative frames before claiming it is ready. Windows software automation beyond the browser requires the target application's API or a separate UI Automation integration; Recorder does not provide arbitrary desktop input.
