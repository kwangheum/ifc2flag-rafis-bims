# IFC to FRAG 백엔드

That Open `IfcImporter` 기반으로 IFC 파일을 FRAG로 변환하는 백엔드입니다.

`/api/conversions/ifc`로 전달된 첨부파일 번호를 기준으로 `.ifc` 파일을 변환하고, 변환된 `.frag` 파일은 같은 위치의 `frags` 폴더에 생성됩니다.

## API

### `POST /api/conversions/ifc`

- 요청 형식: `application/json`
- 요청 본문 예시:

```json
{
  "attachmentId": "12345"
}
```

- 동작:
  `BIM_CM010D_TB` 테이블에서 `attachmentId`에 해당하는 `FLPTH`와 `STRE_NM`을 조회한 뒤 `FLPTH + "/" + STRE_NM` 경로의 IFC를 FRAG로 변환합니다.
  변환 전 상태값은 `1`, 실패 시 `2`, 성공 시 `3`으로 업데이트합니다.

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
  - `bundle/web-ifc/*.wasm`

## 운영 서버 실행 예시

```bash
nohup node server.js > app.log 2>&1 &
```

## 저장 구조 예시

```text
uploadRoot/
  2026/
    03/
      sample.ifc
      frags/
        sample.frag
```

## 참고

- 현재 업로드 기본 경로는 `src/config.ts`의 `uploadRoot`에 고정되어 있습니다.
- `IfcImporter` 사용 방식은 That Open 공식 문서를 참고했습니다:
  [That Open IfcImporter 튜토리얼](https://thatopen.github.io/engine_past-docs/3.0.x/Tutorials/Fragments/Fragments/IfcImporter/)
