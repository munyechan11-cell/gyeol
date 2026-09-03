import { increment, newId, removeDoc, saveDoc } from "../../lib/db";
import type { StoreCore } from "../core";
import { useCallback } from "react";
import type { OrderItem, Ingredient, Expense } from "../../lib/types";

/** 주문·테이블 정리 양쪽이 공유하는 재고 차감 시그니처. */
export type AdjustStock = (items: OrderItem[], direction: -1 | 1) => Promise<void>;

export function useInventoryActions(core: StoreCore) {
  const { menus, ingredients, expenses, menusRef } = core;


  // ============ INGREDIENTS ============
  const addIngredient = useCallback(
    async (storeId: string, data: Omit<Ingredient, "id" | "storeId" | "updatedAt">) => {
      const id = newId();
      const doc: Ingredient = {
        id,
        storeId,
        ...data,
        updatedAt: new Date().toISOString(),
      };
      await saveDoc("ingredients", id, doc);
    },
    []
  );

  const updateIngredient = useCallback(
    async (id: string, data: Partial<Ingredient>) => {
      await saveDoc("ingredients", id, {
        ...data,
        updatedAt: new Date().toISOString(),
      });
    },
    []
  );

  const deleteIngredient = useCallback(async (id: string) => {
    await removeDoc("ingredients", id);
  }, []);

  const addExpense = useCallback(
    async (storeId: string, data: Omit<Expense, "id" | "storeId" | "createdAt">) => {
      const id = newId();
      const docData: Expense = { id, storeId, createdAt: new Date().toISOString(), ...data };
      await saveDoc("expenses", id, docData);
    },
    []
  );
  const deleteExpense = useCallback(async (id: string) => {
    await removeDoc("expenses", id);
  }, []);


  /**
   * 주문 항목 기반으로 원재료 재고를 일괄 차감/복원.
   * direction: -1 = 차감(판매), +1 = 복원(주문 취소).
   * menus.recipe 의 quantityPerServing × orderItem.quantity 만큼 ingredient.stock 변동.
   *
   * 동시성 안전: Firestore increment() 서버측 atomic 연산 사용.
   * read-modify-write 가 아니라 서버에서 직접 +/- 가 적용되므로
   * 두 테이블 동시 주문이 같은 원재료를 차감해도 손실 없음.
   * 음수 클램프(stock 이 0 미만으로 안 가게)는 서버 sentinel 로 불가능 →
   * 추후 Cloud Function 트리거 또는 룰에서 검증. 클라이언트 표시 시 Math.max(0, ...) 폴백.
   */
  const adjustStockForOrder = useCallback(
    async (items: OrderItem[], direction: -1 | 1) => {
      const menusList = menusRef.current;
      // 같은 원재료가 여러 메뉴에 걸쳐 나오면 누적
      const deltaMap = new Map<string, number>();
      for (const it of items) {
        const menu = menusList.find((m) => m.id === it.menuId);
        if (!menu) continue;
        // 기본 레시피 + 선택된 옵션의 레시피(곱빼기 등) 모두 차감
        const recipes: { ingredientId: string; quantity: number }[] = [...(menu.recipe ?? [])];
        if (it.selectedOptions?.length && menu.optionGroups) {
          for (const so of it.selectedOptions) {
            const opt = menu.optionGroups.find((g) => g.id === so.groupId)?.options.find((o) => o.id === so.optionId);
            if (opt?.recipe) recipes.push(...opt.recipe);
          }
        }
        for (const r of recipes) {
          const cur = deltaMap.get(r.ingredientId) ?? 0;
          deltaMap.set(r.ingredientId, cur + r.quantity * it.quantity * direction);
        }
      }
      // Firestore atomic increment 로 일괄 갱신 — race 안전
      const updates: Promise<void>[] = [];
      for (const [ingId, delta] of deltaMap) {
        if (delta === 0) continue;
        updates.push(
          saveDoc("ingredients", ingId, {
            stock: increment(delta),
            updatedAt: new Date().toISOString(),
          } as any)
        );
      }
      await Promise.all(updates);
    },
    []
  );

  return { addIngredient, updateIngredient, deleteIngredient, addExpense, deleteExpense, adjustStockForOrder };
}
