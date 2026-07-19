import React, { useState, useEffect } from "react";
import { Category } from "../types";
import { Plus, Trash2, Tag } from "lucide-react";

export default function CategoryManager() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");

  const fetchCategories = async () => {
    try {
      const res = await fetch("/api/categories");
      const data = await res.json();
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
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() })
      });
      const data = await res.json();
      if (data.success) {
        setCategories(data.categories);
        setName("");
      }
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteCategory = async (id: string) => {
    if (!confirm("Are you sure you want to delete this category?")) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/categories/${id}`, {
        method: "DELETE"
      });
      const data = await res.json();
      if (data.success) {
        setCategories(data.categories);
      }
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
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

        <div className="space-y-2 max-h-60 overflow-y-auto">
          {categories.map(cat => (
            <div key={cat.id} className="flex justify-between items-center bg-stone-50 border border-stone-100 p-2.5 rounded-lg">
              <span className="text-xs font-semibold text-stone-700 capitalize">{cat.name}</span>
              <button
                onClick={() => handleDeleteCategory(cat.id)}
                className="text-stone-400 hover:text-red-600 transition-colors cursor-pointer"
                title="Delete Category"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          {categories.length === 0 && (
            <p className="text-xs text-stone-500 text-center py-4">No categories added yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
