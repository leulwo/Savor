import React, { useState, useEffect, useRef } from "react";
import { Category } from "../types";
import { Plus, Trash2, Tag, GripVertical, Save } from "lucide-react";
import { db } from "../firebase";
import { collection, getDocs, doc, setDoc, deleteDoc } from "firebase/firestore";
import { hasPermission, PermissionMap } from "../permissions";
import { confirmDialog } from "../notify";

interface CategoryManagerProps {
  can?: (key: string) => boolean;
  permissions?: PermissionMap;
}

export default function CategoryManager({ can, permissions }: CategoryManagerProps) {
  const [saved, setSaved] = useState<Category[]>([]);
  const [draft, setDraft] = useState<Category[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const canManage = can ? can("menu.categories") : hasPermission(permissions, "menu.categories");

  const dirty = draft.length > 0 && JSON.stringify(draft.map(c => c.id)) !== JSON.stringify(saved.map(c => c.id));

  const fetchCategories = async () => {
    try {
      const snapshot = await getDocs(collection(db, "categories"));
      const data = (snapshot?.docs || []).map(doc => ({ id: doc.id, ...doc.data() })) as Category[];
      const ordered = [...data].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      setSaved(ordered);
      setDraft(ordered);
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

    confirmDialog(`Add the new category "${name.trim()}"? You'll be able to assign menu items to it.`, async () => {
      setLoading(true);
      try {
        const id = name.trim().toLowerCase().replace(/\s+/g, '-');
        const maxOrder = draft.reduce((m, c) => Math.max(m, c.sortOrder ?? 0), 0);
        await setDoc(doc(db, "categories", id), { name: name.trim(), sortOrder: maxOrder + 1 });
        await fetchCategories();
        setName("");
      } catch (error) {
        console.error(error);
      } finally {
        setLoading(false);
      }
    }, null, "Add");
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

  const handleDrop = (targetIndex: number) => {
    if (dragIndex === null || dragIndex === targetIndex) {
      setDragIndex(null);
      setOverIndex(null);
      return;
    }
    const next = [...draft];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(targetIndex, 0, moved);
    setDraft(next);
    setDragIndex(null);
    setOverIndex(null);
  };

  const saveOrder = async () => {
    setSaving(true);
    try {
      await Promise.all(
        draft.map((cat, i) => setDoc(doc(db, "categories", cat.id), { ...cat, sortOrder: i }, { merge: true }))
      );
      await fetchCategories();
    } catch (error) {
      console.error("Failed to save category order", error);
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft(saved);
    setDragIndex(null);
    setOverIndex(null);
  };

  return (
    <div className="bg-white rounded-3xl shadow-sm border border-stone-200 overflow-hidden font-sans">
      <div className="p-5 bg-stone-50 border-b border-stone-200 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Tag className="w-5 h-5 text-stone-600" />
          <h2 className="font-serif text-lg font-bold text-stone-900">Categories</h2>
        </div>
        {canManage && draft.length > 1 && (
          <span className="text-[10px] text-stone-500 font-mono">Drag to reorder</span>
        )}
      </div>

      {canManage && dirty && (
        <div className="px-5 pt-4">
          <div className="flex items-center justify-between gap-3 p-3 rounded-xl border border-amber-300 bg-amber-50">
            <span className="text-[11px] text-amber-800 font-medium">You have un-saved order changes.</span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={discard}
                disabled={saving}
                className="text-[11px] font-bold uppercase tracking-wider px-3 py-1.5 rounded-lg bg-white border border-stone-300 text-stone-600 hover:bg-stone-100 transition-colors disabled:opacity-50 cursor-pointer"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={saveOrder}
                disabled={saving}
                className="text-[11px] font-bold uppercase tracking-wider px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white transition-colors disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
              >
                {saving ? <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save Order
              </button>
            </div>
          </div>
        </div>
      )}

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

        <div ref={containerRef} className="space-y-2 max-h-60 overflow-y-auto">
          {draft.map((cat, index) => (
            <div
              key={cat.id}
              draggable={canManage}
              onDragStart={(e) => {
                setDragIndex(index);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", cat.id);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (overIndex !== index) setOverIndex(index);
              }}
              onDragLeave={() => {
                if (overIndex === index) setOverIndex(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                handleDrop(index);
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
              className={`flex justify-between items-center bg-stone-50 border rounded-lg p-2.5 transition-all ${
                overIndex === index ? "border-amber-500 ring-2 ring-amber-500/30" : "border-stone-100"
              } ${dragIndex === index ? "opacity-50 border-amber-400" : ""}`}
            >
              <div className="flex items-center space-x-2 min-w-0">
                {canManage && (
                  <GripVertical className="w-4 h-4 text-stone-300 cursor-grab active:cursor-grabbing shrink-0" />
                )}
                <span className="text-xs font-semibold text-stone-700 capitalize truncate">
                  {index + 1}. {cat.name}
                </span>
              </div>
              {canManage && (
                <button
                  onClick={() => handleDeleteCategory(cat.id)}
                  className="text-stone-400 hover:text-red-600 transition-colors cursor-pointer ml-1"
                  title="Delete Category"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
          {(!draft || draft.length === 0) && (
            <p className="text-xs text-stone-500 text-center py-4">No categories added yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
