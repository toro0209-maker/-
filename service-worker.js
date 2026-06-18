// 성찰의 카드 — 서비스 워커 (v3, 클라우드 동기화 버전)
// 이 버전은 Firestore 실시간 데이터를 다루므로 "네트워크 우선" 전략을 쓴다.
// 정적 파일(화면, 라이브러리)은 캐시해 오프라인에서도 화면이 뜨게 하지만,
// 네트워크가 있을 때는 항상 최신 파일을 우선 사용한다.

const CACHE_NAME = "reflection-cards-v3";
const CORE_ASSETS = [
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./react.production.min.js",
  "./react-dom.production.min.js",
  "./firebase-app.js",
  "./firebase-auth.js",
  "./firebase-firestore.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

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

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  // Firestore/구글 인증 요청은 서비스 워커가 손대지 않고 그대로 통과시킨다.
  const url = event.request.url;
  if (
    url.includes("firestore.googleapis.com") ||
    url.includes("googleapis.com") ||
    url.includes("google.com")
  ) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then((cached) => {
          if (cached) return cached;
          if (event.request.mode === "navigate") {
            return caches.match("./index.html");
          }
        });
      })
  );
});
