import React, { useState, useEffect } from "react";
import { Category } from "../types";
import { Plus, Trash2, Tag, GripVertical, Save } from "lucide-react";
import { db } from "../firebase";
import { collection, getDocs, doc, setDoc, deleteDoc } from "firebase/firestore";
import { hasPermission, PermissionMap } from "../permissions";
import { confirmDialog } from "../notify";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

interface CategoryManagerProps {
  can?: (key: string) => boolean;
  permissions?: PermissionMap;
}

interface SortableCategoryRowProps {
  cat: Category;
  index: number;
  canManage: boolean;
  onDelete: (id: string) => void;
}

function SortableCategoryRow({
  cat,
  index,
  canManage,
  onDelete
}: SortableCategoryRowProps & { key?: React.Key }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: cat.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : "auto"
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex justify-between items-center bg-stone-50 border rounded-lg p-2.5 transition-all ${
        isDragging ? "border-amber-400 shadow-lg" : "border-stone-100"
      }`}
    >
      <div className="flex items-center space-x-2 min-w-0">
        {canManage && (
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="text-stone-300 hover:text-stone-500 cursor-grab active:cursor-grabbing shrink-0 p-0.5 -ml-1"
            title="Drag to reorder"
            aria-label="Drag to reorder"
          >
            <GripVertical className="w-4 h-4" />
          </button>
        )}
        <span className="text-xs font-semibold text-stone-700 capitalize truncate">
          {index + 1}. {cat.name}
        </span>
      </div>
      {canManage && (
        <button
          onClick={() => onDelete(cat.id)}
          className="text-stone-400 hover:text-red-600 transition-colors cursor-pointer ml-1"
          title="Delete Category"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

export default function CategoryManager({ can, permissions }: CategoryManagerProps) {
  const [saved, setSaved] = useState<Category[]>([]);
  const [draft, setDraft] = useState<Category[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");

  const canManage = can ? can("menu.categories") : hasPermission(permissions, "menu.categories");

  const dirty = draft.length > 0 && JSON.stringify(draft.map(c => c.id)) !== JSON.stringify(saved.map(c => c.id));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

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

  const handleDeleteCategory = (id: string) => {
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

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setDraft(items => {
      const oldIndex = items.findIndex(c => c.id === active.id);
      const newIndex = items.findIndex(c => c.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return items;
      return arrayMove(items, oldIndex, newIndex);
    });
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

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={draft.map(c => c.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {draft.map((cat, index) => (
                <SortableCategoryRow
                  key={cat.id}
                  cat={cat}
                  index={index}
                  canManage={canManage}
                  onDelete={handleDeleteCategory}
                />
              ))}
              {(!draft || draft.length === 0) && (
                <p className="text-xs text-stone-500 text-center py-4">No categories added yet.</p>
              )}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}
