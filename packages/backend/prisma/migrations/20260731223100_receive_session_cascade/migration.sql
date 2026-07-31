-- A receive session is meaningless without its list; cascade matches ShoppingListItem.
ALTER TABLE "receive_session" DROP CONSTRAINT "receive_session_shoppingListId_fkey";
ALTER TABLE "receive_session" ADD CONSTRAINT "receive_session_shoppingListId_fkey" FOREIGN KEY ("shoppingListId") REFERENCES "shopping_list"("id") ON DELETE CASCADE ON UPDATE CASCADE;
