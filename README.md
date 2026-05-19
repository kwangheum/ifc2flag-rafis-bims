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

## DB 설정

- 테스트 서버: Oracle
- 운영 서버: Tibero6
- `src/config.ts`의 `activeDbEnvironment` 값을 `test`로 두면 Oracle 테스트 DB, `production`으로 바꾸면 Tibero6 운영 DB로 접속합니다.

### 테스트 서버 Oracle

접속 정보는 `src/config.ts`의 `dbConfigs.test`에 선언합니다.

### 운영 서버 Tibero6

운영 서버에는 Tibero6 ODBC 드라이버와 DSN이 먼저 설정되어 있어야 합니다.
접속 정보는 `src/config.ts`의 `dbConfigs.production`에 선언합니다.

## 번들 빌드 (운영서버 반영할땐 번들로 해서 해당 파일들 다 올리세요)

```bash
npm run build:bundle
```

- 배포용 실행 파일은 `bundle/` 아래에 생성됩니다.
- 주요 파일:
  - `bundle/server.js`
  - `bundle/web-ifc/*.wasm`
- Oracle/Tibero DB 드라이버는 native 모듈이라 번들에 포함하지 않습니다. 배포 서버에서 `npm install --omit=dev`를 실행해 `oracledb`, `odbc`를 설치한 뒤 실행하세요.

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
- DB 기본 설정은 `src/config.ts`에 있습니다.
- `IfcImporter` 사용 방식은 That Open 공식 문서를 참고했습니다:
  [That Open IfcImporter 튜토리얼](https://thatopen.github.io/engine_past-docs/3.0.x/Tutorials/Fragments/Fragments/IfcImporter/)
