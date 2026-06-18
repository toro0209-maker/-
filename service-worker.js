// 성찰의 카드 — 서비스 워커
// 화면을 그리는 파일만 캐시한다. 사용자 데이터(localStorage)는 건드리지 않는다.

const CACHE_NAME = "reflection-cards-v1";
const CORE_ASSETS = [
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

// 설치: 핵심 파일을 미리 내려받아 캐시에 저장
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

// 활성화: 이전 버전 캐시 정리
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

// 요청 처리: 캐시를 우선 사용하고, 없으면 네트워크로 받아온 뒤 캐시에 저장
// (구글 폰트 등 외부 리소스도 받아오는 대로 캐시되어 다음 오프라인 실행을 돕는다)
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
          if (!response || response.status !== 200) return response;
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => {
          // 오프라인이고 캐시에도 없는 경우 — 메인 화면으로 대체
          if (event.request.mode === "navigate") {
            return caches.match("./index.html");
          }
        });
    })
  );
});
