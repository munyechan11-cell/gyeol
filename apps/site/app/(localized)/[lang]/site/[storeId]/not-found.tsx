/** 없는 매장 — 크롤러에 404 를 정확히 알려 존재하지 않는 페이지가 색인되지 않게 한다. */
export default function StoreNotFound() {
  return (
    <div className="min-h-screen bg-[#faf7f2] flex flex-col items-center justify-center text-center px-6 text-[#5b5249]">
      <p className="text-[22px] text-[#2b2622] mb-1">가게를 찾을 수 없어요</p>
      <p className="text-[14px] text-[#8a7f74]">주소를 다시 확인해 주세요.</p>
    </div>
  );
}
