# IFC to FRAG 백엔드

That Open `IfcImporter` 기반으로 IFC 파일을 FRAG로 변환하는 백엔드입니다.

업로드된 `.ifc` 파일은 연/월 폴더에 저장되고, 변환된 `.frag` 파일은 같은 위치의 `frags` 폴더에 생성됩니다.

## API

### `POST /api/conversions/upload`

- 요청 형식: `multipart/form-data`
- 필드 이름: `file`
- 동작:
  업로드된 IFC 파일을 `uploadRoot/년/월`에 저장한 뒤, 바로 `uploadRoot/년/월/frags`로 변환합니다.

### `POST /api/conversions/from-upload`

- 요청 형식: `application/json`
- 요청 본문 예시:

```json
{
  "uploadedFilePath": "2026/03/sample.ifc"
}
```

- 동작:
  `uploadRoot` 아래에 이미 저장되어 있는 IFC 파일을 변환합니다.

### `POST /api/conversions/from-path`

- 요청 형식: `application/json`
- 요청 본문 예시:

```json
{
  "attachmentId": "12345"
}
```

- 동작:
  MariaDB에서 `attachmentId`로 첨부파일 경로를 조회한 뒤 IFC를 변환합니다.
  변환 전 상태값은 `1`, 실패 시 `2`, 성공 시 `3`으로 업데이트합니다.

### `GET /api/conversions/:conversionId`

- 현재 사용하지 않습니다.
- 변환 메타데이터 저장이 비활성화되어 있어 `410` 응답을 반환합니다.

### `GET /api/conversions/:conversionId/file`

- 현재 사용하지 않습니다.
- 변환 메타데이터 저장이 비활성화되어 있어 `410` 응답을 반환합니다.

## 로컬 실행

```bash
npm install
npm run dev
```

기본 포트는 `3000`입니다.

## 번들 빌드 (운영서버 반영할땐 번들로 해서 해당 파일들 다 올리세요)

```bash
npm run build:bundle
```

- 배포용 실행 파일은 `bundle/` 아래에 생성됩니다.
- 주요 파일:
  - `bundle/server.js`
  - `bundle/convert.js`
  - `bundle/convert.cjs`
  - `bundle/public/`
  - `bundle/web-ifc/*.wasm`

## 운영 서버 실행 예시

```bash
nohup node server.js > app.log 2>&1 &
```

## 폴더 일괄 변환

```bash
nohup node convert.js > convert.log 2>&1 &
```

- `convert.cjs` 안의 `TARGET_ROOT` 경로를 기준으로 하위 폴더를 재귀 탐색합니다.
- 모든 `.ifc` 파일을 찾아 같은 폴더 아래 `frag/<같은이름>.frag` 형태로 변환합니다.
- 변환 중 오류가 난 파일은 건너뛰고 다음 파일을 계속 처리합니다.

## 저장 구조 예시

```text
uploadRoot/
  2026/
    03/
      sample.ifc
      frags/
        sample.frag
```

## TC_CMN_ATCHMNFL 기준 읽고 파일 변경 및 IFC DB(info) 적재

```bash
nohup node convertAtt.js > convertAtt.log 2>&1 &
```

## 참고

- 현재 업로드 기본 경로는 `src/config.ts`의 `uploadRoot`에 고정되어 있습니다.
- 샘플 업로드 페이지는 `/` 경로로 제공됩니다.
- `IfcImporter` 사용 방식은 That Open 공식 문서를 참고했습니다:
  [That Open IfcImporter 튜토리얼](https://thatopen.github.io/engine_past-docs/3.0.x/Tutorials/Fragments/Fragments/IfcImporter/)
