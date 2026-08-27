---
name: project_youtube_webrtc_mediamtx_path_bug
description: WEBRTC_ENGINE=mediamtx로 전환 시 YouTube 카메라만 WebRTC connection failed 나던 버그 원인+수정 (2026-07-23)
metadata: 
  node_type: memory
  type: project
  originSessionId: 7d6c0e90-9631-4851-bfaf-49f416de19ca
  modified: 2026-07-23T03:55:51.282Z
---

WEBRTC_ENGINE=mediamtx일 때 RTSP/ONVIF 카메라는 WebRTC가 정상 동작하지만 YouTube 가상 카메라는 항상 "WebRTC connection failed"로 실패하던 버그를 2026-07-23에 수정함.

**원인**: YouTube 카메라는 `youtubeStreamService.js`가 ffmpeg로 MediaMTX에 `yt/{cameraId}` 경로로 publish하는데, `pipelineManager.js`는 YouTube 카메라를 `needsMediaMTX`에서 의도적으로 제외해(루프백 방지, §6.16) `{cameraId}`(접두사 없음) 경로를 별도로 만들지 않음. 그런데 `mediamtxEngine.js`의 `negotiate()`는 항상 `${cameraId}/whep`로 WHEP 요청을 보내고 있어서 YouTube 카메라는 항상 404. 게다가 `pipelineManager.js`의 `useWebRTC` 계산도 YouTube 카메라의 `mediamtxReady`가 (같은 이유로) 항상 false라서 서버 쪽 상태도 "WebRTC 비활성"으로 기록되고 있었음.

**수정**: `server/src/index.js`의 WHEP 라우트가 `db.findOne('cameras', {id})`로 `camera.type==='youtube'`를 확인해 `mediamtxPath='yt/'+cameraId`를 `negotiate(cameraId, sdpOffer, mediamtxPath)`에 3번째 인자로 전달. `pipelineManager.js`는 `isYouTube`일 때 `mediamtxReady` 대신 `true`를 신뢰(mediasoup 엔진이 이미 주던 것과 동일 신뢰 수준).

**How to apply**: 이후 세션에서 "YouTube WebRTC 안 됨"류 재현 보고가 있으면 먼저 이 수정이 실제로 배포/재시작됐는지부터 확인(서버 재시작 필요 — 코드만 고쳐지고 아직 재시작 안 됐으면 재현됨). RTSP/ONVIF 카메라 WHEP 경로는 이 수정으로 영향받지 않음(mediamtxPath가 undefined면 기존과 동일). 상세: [[project_webrtc_5mp_freeze_investigation]] (같은 WebRTC 엔진 영역, 별개 버그), `docs/design/Design_WebRTC_Engine_Modes.md` §3.5.
