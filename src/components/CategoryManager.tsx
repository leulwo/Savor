import React, { useState, useEffect } from "react";
import { Category } from "../types";
import { Plus, Trash2, Tag } from "lucide-react";
import { db } from "../firebase";
import { collection, getDocs, doc, setDoc, deleteDoc } from "firebase/firestore";
import { hasPermission, PermissionMap } from "../permissions";
import { confirmDialog } from "../notify";

interface CategoryManagerProps {
  can?: (key: string) => boolean;
  permissions?: PermissionMap;
}

export default function CategoryManager({ can, permissions }: CategoryManagerProps) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");

  const canManage = can ? can("menu.categories") : hasPermission(permissions, "menu.categories");

  const fetchCategories = async () => {
    try {
      const snapshot = await getDocs(collection(db, "categories"));
      const data = (snapshot?.docs || []).map(doc => ({ id: doc.id, ...doc.data() })) as Category[];
      setCategories(data);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchCategories();
  }, []);

  const handleAddCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);

    try {
      const id = name.trim().toLowerCase().replace(/\s+/g, '-');
      await setDoc(doc(db, "categories", id), { name: name.trim() });
      await fetchCategories();
      setName("");
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteCategory = async (id: string) => {
    confirmDialog("Are you sure you want to delete this category?", async () => {
      setLoading(true);
      try {
        await deleteDoc(doc(db, "categories", id));
        await fetchCategories();
      } catch (error) {
        console.error(error);
      } finally {
        setLoading(false);
      }
    }, null, "Delete");
  };

  return (
    <div className="bg-white rounded-3xl shadow-sm border border-stone-200 overflow-hidden font-sans">
      <div className="p-5 bg-stone-50 border-b border-stone-200 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Tag className="w-5 h-5 text-stone-600" />
          <h2 className="font-serif text-lg font-bold text-stone-900">Categories</h2>
        </div>
      </div>
      <div className="p-5 space-y-4">
        {canManage ? (
          <form onSubmit={handleAddCategory} className="flex space-x-2">
            <input
              type="text"
              required
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="New Category Name"
              className="flex-grow text-xs bg-white border border-stone-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
            <button
              type="submit"
              disabled={loading}
              className="bg-stone-900 hover:bg-stone-800 text-white px-3 py-2 rounded-lg text-xs font-bold transition-colors disabled:opacity-50 flex items-center"
            >
              <Plus className="w-4 h-4 mr-1" />
              Add
            </button>
          </form>
        ) : (
          <p className="text-[11px] text-stone-400">Read only — you need the "Manage categories" permission to add or delete categories.</p>
        )}

        <div className="space-y-2 max-h-60 overflow-y-auto">
          {(categories || []).map(cat => (
            <div key={cat.id} className="flex justify-between items-center bg-stone-50 border border-stone-100 p-2.5 rounded-lg">
              <span className="text-xs font-semibold text-stone-700 capitalize">{cat.name}</span>
              {canManage && (
                <button
                  onClick={() => handleDeleteCategory(cat.id)}
                  className="text-stone-400 hover:text-red-600 transition-colors cursor-pointer"
                  title="Delete Category"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
          {(!categories || categories.length === 0) && (
            <p className="text-xs text-stone-500 text-center py-4">No categories added yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
