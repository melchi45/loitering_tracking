import re

def translate_file(filepath, replacements):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    original = content
    for korean, english in replacements:
        content = content.replace(korean, english)
    if content != original:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        return True
    return False

BASE = '/home/youngho/workspace/loitering_tracking'

# ============================================================
# RFP_Ideal_Proposal.md
# NOTE: Lines inside code blocks (```) are NOT translated.
# ============================================================
ideal_replacements = [
    # Headings / section titles
    ('## 개요', '## Overview'),
    ('본 문서는 RTSP 기반 영상 스트림에서 사람의 배회(loitering) 행동을 탐지하기 위한 AI 기반 Adaptive Multi-Feature Tracking 시스템의 구현 방향 및 RFP(Request For Proposal)를 정의한다.',
     'This document defines the implementation direction and RFP (Request For Proposal) for an AI-based Adaptive Multi-Feature Tracking system designed to detect human loitering behavior in RTSP-based video streams.'),
    ('기존 Kalman Filter 기반 tracking 시스템의 한계를 개선하기 위해:',
     'To address the limitations of existing Kalman Filter-based tracking systems:'),
    ('을 결합한 구조를 사용한다.', 'a combined architecture is used.'),
    ('# 기존 Kalman Filter 기반 Loitering Detection의 문제점',
     '# Problems with Existing Kalman Filter-based Loitering Detection'),
    ('기존 구조:', 'Existing structure:'),
    ('문제점:', 'Problems:'),
    ('- Detection 흔들림', '- Detection jitter'),
    ('- Tracking ID 변경', '- Tracking ID changes'),
    ('- Occlusion 발생', '- Occlusion occurs'),
    ('- 재등장 시 다른 사람으로 인식', '- Re-appearing person recognized as different individual'),
    ('- 느린 움직임에서 오탐 증가', '- Increased false positives with slow movement'),
    ('- 고정 Kalman parameter의 한계', '- Limitations of fixed Kalman parameters'),
    ('즉:', 'In other words:'),
    ('- 너무 예민하거나', '- Too sensitive, or'),
    ('- 너무 둔감한', '- Too insensitive'),
    ('문제가 발생한다.', 'issues arise.'),
    # Improvement section
    ('# 개선 방향', '# Improvement Direction'),
    ('## 핵심 아이디어', '## Core Idea'),
    ('단순 위치 추적이 아닌:', 'Rather than simple position tracking:'),
    ('을 함께 사용하는 것이다.', 'are used together.'),
    ('# 전체 시스템 구조', '# Overall System Architecture'),
    # Section 1
    ('## 목적\n\n영상에서 사람을 검출한다.', '## Purpose\n\nDetect people in the video.'),
    ('## 권장 모델\n\n- YOLOv11', '## Recommended Models\n\n- YOLOv11'),
    ('## 출력 예시', '## Output Example'),
    # Section 2
    ('## 목적\n\nBounding box 내부에서 실제 사람 영역을 분리한다.',
     '## Purpose\n\nIsolate the actual person region inside the bounding box.'),
    ('## 장점\n\n- 배경 제거\n- 의복 분리\n- Accessory 분석 가능\n- Partial Occlusion 대응',
     '## Advantages\n\n- Background removal\n- Clothing separation\n- Accessory analysis possible\n- Partial Occlusion handling'),
    ('## 권장 모델\n\n- YOLO-Seg', '## Recommended Models\n\n- YOLO-Seg'),
    ('## 출력\n\n```text\nperson mask\n```', '## Output\n\n```text\nperson mask\n```'),
    # Section 3
    ('## 목적\n\n사람의 외형 특징을 embedding vector로 변환한다.',
     '## Purpose\n\nConvert a person\'s appearance features into an embedding vector.'),
    ('## 추출 항목', '## Extracted Attributes'),
    ('- 상의 색상', '- Upper body color'),
    ('- 하의 색상', '- Lower body color'),
    ('- 패턴', '- Pattern'),
    ('- 체형', '- Body type'),
    ('- 가방', '- Bag'),
    ('- 모자', '- Hat'),
    ('- 액세서리', '- Accessories'),
    ('## 예시\n\n```text\nperson_embedding[512]\n```', '## Example\n\n```text\nperson_embedding[512]\n```'),
    # Section 4
    ('## 목적\n\n외형 정보를 semantic metadata로 저장한다.',
     '## Purpose\n\nStore appearance information as semantic metadata.'),
    ('## 예시\n\n```json\n{\n  "upper_color": "red"', '## Example\n\n```json\n{\n  "upper_color": "red"'),
    ('## 장점\n\n- Explainability 증가\n- ReID 정확도 향상\n- 조명 변화 대응',
     '## Advantages\n\n- Increased explainability\n- Improved ReID accuracy\n- Handles lighting changes'),
    # Section 5
    ('## 목적\n\n사람의 이동 상태를 예측한다.', '## Purpose\n\nPredict a person\'s motion state.'),
    ('## 상태 벡터', '## State Vector'),
    ('## 기능\n\n- 위치 예측\n- Detection 누락 보정\n- 이동 smoothing\n- ID continuity 유지',
     '## Functions\n\n- Position prediction\n- Missed detection compensation\n- Movement smoothing\n- ID continuity maintenance'),
    # Section 6
    ('## 문제\n\n고정 noise parameter 사용 시:\n\n- 빠른 움직임에서 tracking loss\n- 정지 상태에서 과도한 민감도\n- Occlusion 상황에서 오류\n\n발생 가능',
     '## Problem\n\nWhen using fixed noise parameters:\n\n- Tracking loss with fast movement\n- Excessive sensitivity in stationary state\n- Errors in occlusion situations\n\nmay occur'),
    ('# 개선 방법', '# Improvement Methods'),
    ('## Motion 기반 동적 조정', '## Motion-based Dynamic Adjustment'),
    ('- 급가속 → process noise 증가', '- Rapid acceleration → increase process noise'),
    ('- 정지 → process noise 감소', '- Stationary → decrease process noise'),
    ('## Appearance Confidence 기반 조정', '## Appearance Confidence-based Adjustment'),
    ('Appearance matching confidence가 낮을 경우:\n\n- covariance 증가\n- uncertainty 증가',
     'When appearance matching confidence is low:\n\n- Increase covariance\n- Increase uncertainty'),
    ('## Occlusion 기반 조정', '## Occlusion-based Adjustment'),
    ('가려짐 발생 시:\n\n- prediction weight 증가\n- measurement weight 감소',
     'When occlusion occurs:\n\n- Increase prediction weight\n- Decrease measurement weight'),
    # Section 7
    ('## 목적\n\nTracking ID를 안정적으로 유지한다.', '## Purpose\n\nMaintain Tracking IDs stably.'),
    ('## 기존 방식', '## Existing Method'),
    ('## 개선 방식', '## Improved Method'),
    ('## 예시\n\n```text\nScore =', '## Example\n\n```text\nScore ='),
    # Section 8
    ('## 목적\n\n특정 영역에서 장시간 체류하거나 반복 방문하는 행동을 탐지한다.',
     '## Purpose\n\nDetect behavior such as prolonged presence in a specific area or repeated visits.'),
    ('# 권장 판단 요소', '# Recommended Detection Criteria'),
    ('특정 영역 체류 시간', 'Dwell time in a specific area'),
    ('동일 영역 반복 방문 횟수', 'Number of repeated visits to the same area'),
    ('낮은 이동 속도 유지', 'Sustained low movement speed'),
    ('반복 이동 경로 탐지', 'Repeated movement path detection'),
    ('# 상태 저장 예시', '# State Storage Example'),
    ('# 추천 기술 스택', '# Recommended Technology Stack'),
    # Implementation steps
    ('# 권장 구현 단계', '# Recommended Implementation Phases'),
    ('# 1단계\n\n```text\nYOLO + DeepSORT\n```\n\n기본 tracking 구현',
     '# Phase 1\n\n```text\nYOLO + DeepSORT\n```\n\nImplement basic tracking'),
    ('# 2단계\n\nAppearance embedding 추가', '# Phase 2\n\nAdd appearance embedding'),
    ('# 3단계\n\nCloth / accessory detection 추가', '# Phase 3\n\nAdd cloth / accessory detection'),
    ('# 4단계\n\nAdaptive Kalman 적용', '# Phase 4\n\nApply Adaptive Kalman'),
    ('# 5단계\n\nBehavior analysis 및 loitering logic 추가',
     '# Phase 5\n\nAdd behavior analysis and loitering logic'),
    # Performance
    ('# 성능 목표', '# Performance Goals'),
    ('| 항목 | 목표 |', '| Item | Target |'),
    ('| Multi-Person Tracking | 지원 |', '| Multi-Person Tracking | Supported |'),
    # RFP section
    ('## 프로젝트명\n\nAI 기반 Adaptive Multi-Feature Loitering Detection System',
     '## Project Name\n\nAI-based Adaptive Multi-Feature Loitering Detection System'),
    ('# 프로젝트 목적\n\n실시간 RTSP 영상 기반에서:\n\n- 사람 검출\n- 다중 객체 추적\n- Appearance ReID\n- Adaptive Kalman Filtering\n\n을 이용하여:\n\n- 배회자\n- 장시간 체류자\n- 반복 방문 패턴\n\n을 탐지하는 시스템 구축',
     '# Project Purpose\n\nBased on real-time RTSP video:\n\n- Person detection\n- Multi-object tracking\n- Appearance ReID\n- Adaptive Kalman Filtering\n\nare used to build a system to detect:\n\n- Loiterers\n- Long-term dwellers\n- Repeated visit patterns'),
    ('# 주요 요구사항\n\n## 입력\n\n- RTSP Stream\n- H264/H265 지원\n- Multi-channel 지원',
     '# Key Requirements\n\n## Input\n\n- RTSP Stream\n- H264/H265 support\n- Multi-channel support'),
    ('# 기능 요구사항', '# Functional Requirements'),
    ('## Human Detection\n\n- 실시간 detection\n- 다중 인원 지원\n- 최소 15 FPS 이상',
     '## Human Detection\n\n- Real-time detection\n- Multi-person support\n- Minimum 15 FPS'),
    ('## Segmentation\n\n- person mask 생성\n- partial occlusion 대응',
     '## Segmentation\n\n- Generate person mask\n- Handle partial occlusion'),
    ('## Tracking\n\n- Tracking ID 유지\n- ID switch 최소화\n- Kalman prediction 적용',
     '## Tracking\n\n- Maintain Tracking ID\n- Minimize ID switches\n- Apply Kalman prediction'),
    ('## Appearance ReID\n\n지원 항목:\n\n- upper/lower clothes\n- cloth color\n- backpack\n- hat\n- accessory',
     '## Appearance ReID\n\nSupported attributes:\n\n- upper/lower clothes\n- cloth color\n- backpack\n- hat\n- accessory'),
    ('## Adaptive Kalman\n\n동적 parameter 조정:\n\n- motion variance\n- occlusion\n- appearance confidence\n\n기반 adaptive covariance 적용',
     '## Adaptive Kalman\n\nDynamic parameter adjustment based on:\n\n- motion variance\n- occlusion\n- appearance confidence\n\nAdaptive covariance applied'),
    ('## Loitering Detection\n\n복합 조건 기반 판단:\n\n- dwell time\n- revisit count\n- low velocity\n- repetitive motion',
     '## Loitering Detection\n\nMulti-condition-based judgment:\n\n- dwell time\n- revisit count\n- low velocity\n- repetitive motion'),
    ('# 이벤트 출력 예시', '# Event Output Example'),
    ('# 추가 권장 기능', '# Additional Recommended Features'),
    ('## Heatmap\n\n배회 hotspot 시각화', '## Heatmap\n\nVisualize loitering hotspots'),
    ('## Cross-Camera ReID\n\n카메라 간 동일 인물 추적', '## Cross-Camera ReID\n\nTrack the same person across cameras'),
    ('## Suspicious Score\n\n행동 위험도 점수화', '## Suspicious Score\n\nScore behavior risk level'),
    ('# 결론\n\n본 시스템은 단순 Kalman 기반 위치 추적을 넘어:',
     '# Conclusion\n\nThis system goes beyond simple Kalman-based position tracking:'),
    ('를 결합한 Adaptive Intelligent Tracking 구조를 목표로 한다.',
     'targeting an Adaptive Intelligent Tracking architecture that combines all of the above.'),
    ('이를 통해:\n\n- Tracking 안정성 향상\n- ReID 정확도 증가\n- False Alarm 감소\n- 실제 환경 대응력 강화\n\n를 달성할 수 있다.',
     'Through this, the following can be achieved:\n\n- Improved tracking stability\n- Increased ReID accuracy\n- Reduced false alarms\n- Enhanced real-world environment adaptability'),
]

r = translate_file(f'{BASE}/RFP_Ideal_Proposal.md', ideal_replacements)
print(f"RFP_Ideal_Proposal.md: {'updated' if r else 'no changes'}")
