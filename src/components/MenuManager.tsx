/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { MenuItem, MenuItemVariation } from "../types";
import { Plus, Edit2, Trash2, Save, X, Tag, Layers, Star } from "lucide-react";
import { db } from "../firebase";
import { doc, setDoc, updateDoc, deleteDoc, collection, getDocs } from "firebase/firestore";
import { confirmDialog } from "../notify";
import { hasPermission, PermissionMap } from "../permissions";
import { logAudit } from "../utils/auditLogger";
import { normalizeGalleryImages } from "../utils/galleries";
import SquareImageCropper from "./SquareImageCropper";

interface MenuManagerProps {
  onMenuUpdated: () => void;
  menu: MenuItem[];
  userRole?: string | null;
  can?: (key: string) => boolean;
  permissions?: PermissionMap;
  actor?: { email: string; role: string };
}

export default function MenuManager({ menu = [], onMenuUpdated, userRole, can, permissions, actor }: MenuManagerProps) {
  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  const canCreate = can ? can("menu.create") : hasPermission(permissions, "menu.create");
  const canEdit = can ? can("menu.edit") : hasPermission(permissions, "menu.edit");
  const canEditPrice = can ? can("menu.editPrice") : hasPermission(permissions, "menu.editPrice");
  const canEditAvailability = can ? can("menu.editAvailability") : hasPermission(permissions, "menu.editAvailability");
  const canDelete = can ? can("menu.delete") : hasPermission(permissions, "menu.delete");
  const canEditCategories = can ? can("menu.categories") : hasPermission(permissions, "menu.categories");
  const canModify = canCreate || canEdit || canEditPrice || canDelete;
  // Anyone who can edit anything (content), prices, or availability can open the form.
  const canOpenEditor = canEdit || canEditPrice || canEditAvailability || canEditCategories;
  // Content fields (name, description, promo, image, gallery, popular,
  // ingredients, nutrition, timing) on an EXISTING item are only editable with
  // menu.edit. Creating a brand-new item unlocks everything (menu.create writes
  // the full record).
  const isContentLocked = !!selectedItem && !canEdit;
  // Category assignment on an existing item is its own permission
  // (menu.categories); a content editor without it cannot reassign the item.
  const isCategoryLocked = !!selectedItem && !canEditCategories;
  // Pricing is strictly gated by menu.editPrice for existing items (menu.edit /
  // menu.create do NOT imply price editing on saved items). A brand-new item is
  // fully editable because creation is a single menu.create record.
  const priceEditable = selectedItem ? canEditPrice : canCreate;

  // Form States
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState<number>(0);
  const [category, setCategory] = useState<string>(""); // Keep for backwards compatibility/primary
  const [categories, setCategories] = useState<{id: string, name: string}[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedPromoStickers, setSelectedPromoStickers] = useState<string[]>([]);

  const AVAILABLE_PROMO_STICKERS = ["CHEFPICK", "FAST", "HOT", "SPECIAL", "FRESH", "COLD"];

  useEffect(() => {
    const fetchCategories = async () => {
      try {
        const snapshot = await getDocs(collection(db, "categories"));
        const data = (snapshot?.docs || []).map(doc => ({ id: doc.id, ...doc.data() })) as {id: string, name: string}[];
        setCategories(data);
        if (data.length > 0 && !category) {
          setCategory(data[0].id);
        }
      } catch (e) {
        console.error("Failed to fetch categories", e);
      }
    };
    fetchCategories();
  }, []);
  const [image, setImage] = useState("");
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [popular, setPopular] = useState(false);
  const [ingredients, setIngredients] = useState("");
  const [protein, setProtein] = useState("");
  const [carbs, setCarbs] = useState("");
  const [fat, setFat] = useState("");

  // New properties
  const [basePrice, setBasePrice] = useState<number>(0);
  const [isActive, setIsActive] = useState<boolean>(true);
  const [menuTiming, setMenuTiming] = useState<string>("All Day");
  const [timingFrom, setTimingFrom] = useState<string>("08:00");
  const [timingTo, setTimingTo] = useState<string>("11:00");
  const [galleryImages, setGalleryImages] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [variations, setVariations] = useState<MenuItemVariation[]>([]);

  const updateVariation = (index: number, patch: Partial<MenuItemVariation>) => {
    setVariations(prev => prev.map((v, i) => (i === index ? { ...v, ...patch } : v)));
  };

  const setDefaultVariation = (index: number) => {
    setVariations(prev => prev.map((v, i) => ({ ...v, isDefault: i === index })));
  };

  const addVariation = () => {
    setVariations(prev => {
      const next: MenuItemVariation[] = [...prev, {
        id: Math.random().toString(36).substring(2, 10),
        label: "",
        price: 0,
        isAvailable: true
      }];
      if (!next.some(v => v.isDefault)) {
        next[0] = { ...next[0], isDefault: true };
      }
      return next;
    });
  };

  const removeVariation = (index: number) => {
    setVariations(prev => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length > 0 && !next.some(v => v.isDefault)) {
        next[0] = { ...next[0], isDefault: true };
      }
      return next;
    });
  };

  // Variations with a drafted label are "real" variations. Once any exist, the
  // main item's Price + Dish Available are derived from the default (main) variation.
  const draftedVariations = variations.filter(v => String(v.label || "").trim().length > 0);
  const hasDraftedVariations = draftedVariations.length > 0;
  const currentDefaultVariation = draftedVariations.find(v => v.isDefault) || draftedVariations[0] || null;

  const sanitizeVariations = (): MenuItemVariation[] => {
    return variations
      .filter(v => v && String(v.label || "").trim().length > 0)
      .map(v => ({
        id: String(v.id || Math.random().toString(36).substring(2, 10)),
        label: String(v.label).trim(),
        price: parseFloat(v.price as any) || 0,
        isAvailable: v.isAvailable !== false,
        isDefault: v.isDefault === true
      }));
  };

  const resetForm = () => {
    setId("");
    setName("");
    setDescription("");
    setPrice(0);
    setCategory(categories && categories.length > 0 ? categories[0].id : "starters");
    setSelectedCategories([]);
    setSelectedPromoStickers([]);
    setImage("");
    setGalleryImages("");
    setPopular(false);
    setIngredients("");
    setProtein("");
    setCarbs("");
    setFat("");
    setBasePrice(0);
    setIsActive(true);
    setMenuTiming("All Day");
    setTimingFrom("08:00");
    setTimingTo("11:00");
    setVariations([]);
    setSelectedItem(null);
    setIsEditing(false);
  };

  const loadItemToForm = (item: MenuItem) => {
    if (!item) return;
    setSelectedItem(item);
    setId(item.id || "");
    setName(item.name || "");
    setDescription(item.description || "");
    setPrice(item.price || 0);
    setCategory(item.category || "");
    setSelectedCategories(Array.isArray(item.categories) ? item.categories : (item.category ? [item.category] : []));
    setSelectedPromoStickers(Array.isArray(item.promoStickers) ? item.promoStickers : []);
    setImage(item.image || "");
    setGalleryImages(Array.isArray(item.galleryImages) ? normalizeGalleryImages(item.galleryImages).join(", ") : "");
    setPopular(!!item.popular);
    setIngredients(Array.isArray(item.ingredients) ? item.ingredients.join(", ") : "");
    setProtein(item.nutrition?.protein || "");
    setCarbs(item.nutrition?.carbs || "");
    setFat(item.nutrition?.fat || "");
    setBasePrice(item.basePrice !== undefined ? item.basePrice : item.price || 0);
    setIsActive(item.isActive !== false);
    setMenuTiming(item.menuTiming || "All Day");
    setTimingFrom(item.timingFrom || "08:00");
    setTimingTo(item.timingTo || "11:00");
    setVariations(Array.isArray(item.variations) ? item.variations.map(v => ({ ...v })) : []);
    setIsEditing(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    confirmDialog(
      "Save these menu item changes?\n\nChanges to content, price, availability or categories take effect on the live menu immediately.",
      () => { doSave(); },
      null,
      "Save"
    );
  };

  const doSave = async () => {
    const parsedVariations = sanitizeVariations();
    const hasVariations = parsedVariations.length > 0;
    if (!name) {
      setMessage({ type: 'error', text: 'Item name is required.' });
      return;
    }
    if (!hasVariations && parseFloat(price.toString()) <= 0) {
      setMessage({ type: 'error', text: 'Name and a valid positive price are required (or add variations with prices).' });
      return;
    }
    if (!canModify && !canEditAvailability && !canEditCategories) {
      setMessage({ type: 'error', text: 'You do not have permission to create or edit menu items.' });
      return;
    }
    if (!id && !canCreate) {
      setMessage({ type: 'error', text: 'You do not have permission to create menu items.' });
      return;
    }
    if (id && !canCreate && !canEdit && !canEditPrice && !canEditAvailability && !canEditCategories) {
      setMessage({ type: 'error', text: 'You do not have permission to edit this item.' });
      return;
    }

    setLoading(true);
    setMessage(null);

    const parsedIngredients = ingredients
      .split(",")
      .map(i => i.trim())
      .filter(i => i.length > 0);

    const parsedGalleryImages = normalizeGalleryImages(galleryImages);

    const itemId = id || Math.random().toString(36).substring(2, 11);

    // When variations exist, the default variation IS the main item:
    // its price drives the headline price and its availability is the master switch.
    let effectivePrice = parseFloat(price.toString());
    let effectiveIsActive = isActive;
    if (hasVariations) {
      const def = parsedVariations.find(v => v.isDefault) || parsedVariations[0];
      parsedVariations.forEach(v => { v.isDefault = v.id === def.id; });
      effectivePrice = parseFloat(def.price as any) || 0;
      effectiveIsActive = parsedVariations.some(v => v.isAvailable !== false);
    }

    const priceFields = {
      price: effectivePrice,
      basePrice: parseFloat(basePrice.toString()) || effectivePrice,
    };

    const payload = {
      id: itemId,
      name,
      description,
      ...priceFields,
      category: selectedCategories.length > 0 ? selectedCategories[0] : category,
      categories: selectedCategories.length > 0 ? selectedCategories : [category],
      promoStickers: selectedPromoStickers,
      image: image || "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&q=80&w=600",
      galleryImages: parsedGalleryImages,
      popular,
      ingredients: parsedIngredients,
      nutrition: {
        protein,
        carbs,
        fat
      },
      isActive: effectiveIsActive,
      menuTiming,
      ...(menuTiming !== "All Day" ? { timingFrom, timingTo } : {}),
      variations: parsedVariations
    };

    // ---- Strict-separation save path ----
    // A brand-new dish (no id) is a single full-record create, gated by
    // menu.create. An existing dish is updated field-by-field: each permission
    // group is written in its OWN updateDoc so the strict rules accept the
    // write and no permission can implicitly edit another group's fields.
    const isCreate = !id;
    const availabilityFields: any = { isActive: effectiveIsActive };
    if (hasVariations) {
      const def = parsedVariations.find(v => v.isDefault) || parsedVariations[0];
      availabilityFields.variations = parsedVariations.map(v =>
        v.id === def.id ? { ...v, isAvailable: effectiveIsActive } : v
      );
    }

    const contentPatch: any = {
      name,
      description,
      promoStickers: selectedPromoStickers,
      image: payload.image,
      galleryImages: parsedGalleryImages,
      popular,
      ingredients: parsedIngredients,
      nutrition: { protein, carbs, fat },
      menuTiming,
    };
    if (menuTiming !== "All Day") {
      contentPatch.timingFrom = timingFrom;
      contentPatch.timingTo = timingTo;
    }
    const categoryPatch = {
      category: selectedCategories.length > 0 ? selectedCategories[0] : category,
      categories: selectedCategories.length > 0 ? selectedCategories : [category],
    };

    try {
      if (isCreate) {
        if (!canCreate) {
          setMessage({ type: 'error', text: 'You do not have permission to create menu items.' });
          setLoading(false);
          return;
        }
        await setDoc(doc(db, "menu", itemId), payload);
      } else {
        const writes: Promise<void>[] = [];
        if (canEdit) writes.push(updateDoc(doc(db, "menu", itemId), contentPatch));
        if (canEditPrice) writes.push(updateDoc(doc(db, "menu", itemId), priceFields));
        if (canEditAvailability) writes.push(updateDoc(doc(db, "menu", itemId), availabilityFields));
        if (canEditCategories) writes.push(updateDoc(doc(db, "menu", itemId), categoryPatch));
        if (writes.length === 0) {
          setMessage({ type: 'error', text: 'You do not have permission to edit this item.' });
          setLoading(false);
          return;
        }
        await Promise.all(writes);
      }
      await logAudit(actor || { email: 'system', role: 'unknown' }, {
        action: id ? 'Updated menu item' : 'Created menu item',
        category: 'menu',
        targetId: itemId,
        details: { name, oldId: id || null, price: parseFloat(price.toString()), menuTiming, timingFrom, timingTo }
      });
      setMessage({ type: 'success', text: id ? 'Item updated successfully!' : 'New menu item added successfully!' });
      onMenuUpdated();
      resetForm();
    } catch (err: any) {
      setMessage({ type: 'error', text: `Connection error: ${err.message}` });
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (itemId: string) => {
    confirmDialog("Are you sure you want to delete this menu item?", async () => {
      setLoading(true);
      try {
        await deleteDoc(doc(db, "menu", itemId));
        await logAudit(actor || { email: 'system', role: 'unknown' }, {
          action: 'Deleted menu item',
          category: 'menu',
          targetId: itemId,
          details: { name: menu.find(m => m.id === itemId)?.name }
        });
        setMessage({ type: 'success', text: 'Menu item deleted successfully!' });
        onMenuUpdated();
        resetForm();
      } catch (err: any) {
        setMessage({ type: 'error', text: `Connection error: ${err.message}` });
      } finally {
        setLoading(false);
      }
    }, null, "Delete");
  };

  const filteredMenu = (menu || []).filter(item => 
    !item ? false : (
      (item.name || '').toLowerCase().includes(searchQuery.toLowerCase()) || 
      (item.description && item.description.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (item.category || '').toLowerCase().includes(searchQuery.toLowerCase())
    )
  );

  return (
    <div id="menu-manager-admin" className="bg-white border border-stone-200 rounded-2xl p-6 shadow-md font-sans">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-stone-100 pb-4 mb-6">
        <div>
          <h3 className="font-serif text-xl font-bold text-stone-900">Customizer & Template Editor</h3>
          <p className="text-xs text-stone-500">Edit pre-made restaurant items or add custom culinary delights into the database.</p>
        </div>
        {!isEditing && canCreate && (
          <button
            onClick={() => { resetForm(); setIsEditing(true); }}
            className="mt-3 sm:mt-0 flex items-center bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded-xl text-xs font-semibold tracking-wide cursor-pointer transition-colors"
          >
            <Plus className="w-4 h-4 mr-1.5" />
            Add Custom Dish
          </button>
        )}
      </div>

      {message && (
        <div className={`p-3.5 rounded-xl text-xs font-medium mb-5 flex items-center justify-between ${
          message.type === 'success' ? 'bg-emerald-50 border border-emerald-200 text-emerald-800' : 'bg-rose-50 border border-rose-200 text-rose-800'
        }`}>
          <span>{message.text}</span>
          <button onClick={() => setMessage(null)} className="text-stone-400 hover:text-stone-700">
            <X className="w-4.5 h-4.5" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Side: Current Menu List */}
        <div className={`${isEditing ? 'lg:col-span-6' : 'lg:col-span-12'} space-y-3 max-h-[600px] overflow-y-auto pr-2`}>
          <div className="bg-stone-50 p-3 border border-stone-200 rounded-xl space-y-2">
            <div className="text-xs font-bold text-stone-400 uppercase tracking-widest flex items-center justify-between">
              <span>Database Records ({filteredMenu.length} of {(menu || []).length})</span>
              <span className="text-[10px] bg-stone-100 text-stone-600 px-2 py-0.5 rounded-full font-mono font-bold">LIVE SYNC</span>
            </div>
            <input
              type="text"
              placeholder="Search dishes by name, description, category..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full text-xs bg-white border border-stone-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-amber-500 font-medium"
            />
          </div>
          {(filteredMenu || []).map(item => (
            <div key={item.id} className="flex items-center justify-between p-3 border border-stone-150 rounded-xl hover:bg-stone-50 transition-colors">
              <div className="flex items-center space-x-3 truncate">
                <img src={item.image} alt={item.name} className="w-11 h-11 rounded-lg object-cover bg-stone-100 border border-stone-200 flex-shrink-0" />
                <div className="truncate">
                  <h4 className="font-serif font-semibold text-stone-900 text-sm">{item.name}</h4>
                  <p className="text-xs text-stone-500 font-medium flex items-center mt-0.5 capitalize">
                    <Tag className="w-3 h-3 mr-1 text-amber-600" />
                    {(categories || []).find(c => c.id === item.category)?.name || item.category} • <span className="text-emerald-700 font-bold ml-1">{(item.price || 0).toFixed(2)} ETB</span>
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-1.5">
                {canOpenEditor && (
                  <button
                    onClick={() => loadItemToForm(item)}
                    className="p-2 hover:bg-stone-100 rounded-lg text-stone-500 hover:text-stone-950 transition-colors cursor-pointer"
                    title={canEdit ? "Edit item parameters" : canEditAvailability ? "Toggle dish availability" : "Edit item prices"}
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                )}
                {canDelete && (
                  <button
                    onClick={() => handleDelete(item.id)}
                    className="p-2 hover:bg-rose-50 rounded-lg text-stone-400 hover:text-rose-600 transition-colors cursor-pointer"
                    title="Remove from database"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Right Side: Form Editor */}
        {isEditing && (
          <form onSubmit={handleSave} className="lg:col-span-6 bg-stone-50/50 p-5 border border-stone-200 rounded-2xl space-y-4 animate-fade-in">
            <div className="flex items-center justify-between border-b border-stone-200 pb-2 mb-3">
              <h4 className="font-serif font-bold text-sm text-stone-900">
                {id ? `Edit: ${name}` : 'Create Custom Food / Drink'}
              </h4>
              <button type="button" onClick={resetForm} className="text-stone-400 hover:text-stone-800 p-1">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-1">Item Name *</label>
                <input
                  type="text"
                  required
                  disabled={isContentLocked}
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g., Spicy Doro Wat Croquettes"
                  className={`w-full text-xs bg-white border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-amber-500 ${isContentLocked ? 'opacity-60 cursor-not-allowed bg-stone-100' : ''}`}
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-1">Price (ETB) {hasDraftedVariations ? '' : '*'}</label>
                <input
                  type="number"
                  step="0.01"
                  required={!hasDraftedVariations}
                  disabled={!priceEditable || hasDraftedVariations}
                  value={hasDraftedVariations ? ((currentDefaultVariation?.price ?? price) || "") : (price || "")}
                  onChange={e => {
                    const val = parseFloat(e.target.value) || 0;
                    setPrice(val);
                    if (!basePrice || basePrice === 0) {
                      setBasePrice(val);
                    }
                  }}
                  placeholder={hasDraftedVariations ? "Set by default variation" : "320"}
                  className={`w-full text-xs border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 ${(!priceEditable || hasDraftedVariations) ? 'bg-stone-100 text-stone-500 cursor-not-allowed' : 'bg-white'}`}
                />
                {hasDraftedVariations && (
                  <p className="text-[9px] text-stone-400 mt-1">Mirrors the ★ default variation below.</p>
                )}
              </div>

              <div className="col-span-2">
                <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-2">Categories * (Select at least one)</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {(categories || []).map(c => (
                    <label key={c.id} className={`flex items-center space-x-2 bg-stone-50 border border-stone-200 p-2 rounded-lg cursor-pointer hover:bg-stone-100 transition-colors ${isCategoryLocked ? 'opacity-60 cursor-not-allowed' : ''}`}>
                      <input
                        type="checkbox"
                        disabled={isCategoryLocked}
                        checked={(selectedCategories || []).includes(c.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedCategories([...(selectedCategories || []), c.id]);
                          } else {
                            setSelectedCategories((selectedCategories || []).filter(cat => cat !== c.id));
                          }
                        }}
                        className="rounded text-amber-600 focus:ring-amber-500"
                      />
                      <span className="text-xs text-stone-700 font-medium">{c.name}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="col-span-2">
                <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-2">Promo Stickers</label>
                <div className="flex flex-wrap gap-2">
                  {AVAILABLE_PROMO_STICKERS.map(sticker => (
                    <label key={sticker} className={`flex items-center space-x-2 bg-stone-50 border border-stone-200 p-2 rounded-lg cursor-pointer hover:bg-stone-100 transition-colors ${isContentLocked ? 'opacity-60 cursor-not-allowed' : ''}`}>
                      <input
                        type="checkbox"
                        disabled={isContentLocked}
                        checked={selectedPromoStickers.includes(sticker)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedPromoStickers([...selectedPromoStickers, sticker]);
                          } else {
                            setSelectedPromoStickers(selectedPromoStickers.filter(s => s !== sticker));
                          }
                        }}
                        className="rounded text-amber-600 focus:ring-amber-500"
                      />
                      <span className="text-[10px] font-bold uppercase text-stone-600">{sticker}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="col-span-2">
                <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-1">Description</label>
                <textarea
                  value={description}
                  disabled={isContentLocked}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="A detailed description of ingredients, baking methods..."
                  rows={2}
                  className={`w-full text-xs bg-white border border-stone-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-500 ${isContentLocked ? 'opacity-60 cursor-not-allowed bg-stone-100' : ''}`}
                />
              </div>

              <div className="col-span-2">
                <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-1">Main Image</label>
                <div className="space-y-2 bg-white p-3 border border-stone-250 rounded-xl">
                  <div className="flex items-center justify-between">
                    <label className="flex items-center justify-center px-3 py-1.5 border border-stone-300 rounded-lg shadow-xs text-xs font-semibold text-stone-700 bg-white hover:bg-stone-50 cursor-pointer transition-all focus-within:ring-2 focus-within:ring-amber-500">
                      <span>Upload Local Photo</span>
                      <input
                        type="file"
                        accept="image/*"
                        className="sr-only"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            // Instant preview + square crop happen in the modal.
                            setCropFile(file);
                          }
                          e.target.value = "";
                        }}
                      />
                    </label>
                    {image && (
                      <div className="flex items-center space-x-2">
                        <img src={image} alt="Preview" className="w-8 h-8 rounded-lg object-cover border border-stone-200" />
                        <span className="text-[10px] text-emerald-600 font-bold uppercase tracking-wider">
                          {image.startsWith('data:') ? 'Selected' : 'External Preview'}
                        </span>
                      </div>
                    )}
                  </div>
                  {!image && (
                    <p className="text-[10px] text-stone-400">No image uploaded yet. Upload a photo from your device.</p>
                  )}
                </div>
              </div>

              <div className="col-span-2">
                <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-1">Additional Gallery Images</label>
                <div className="space-y-2 bg-white p-3 border border-stone-250 rounded-xl">
                  <div className="flex items-center justify-between">
                    <label className="flex items-center justify-center px-3 py-1.5 border border-stone-300 rounded-lg shadow-xs text-xs font-semibold text-stone-700 bg-white hover:bg-stone-50 cursor-pointer transition-all focus-within:ring-2 focus-within:ring-amber-500">
                      <span>Upload Local Photos</span>
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        className="sr-only"
                        onChange={async (e) => {
                          const files = e.target.files;
                          if (files && files.length > 0) {
                            const newUrls: string[] = [];
                            for (let i = 0; i < files.length; i++) {
                              const file = files[i];
                              const reader = new FileReader();
                              const dataUrl = await new Promise<string>((resolve) => {
                                reader.onloadend = () => resolve(reader.result as string);
                                reader.readAsDataURL(file);
                              });
                              newUrls.push(dataUrl);
                            }
                            setGalleryImages(prev => prev ? `${prev}, ${newUrls.join(', ')}` : newUrls.join(', '));
                          }
                        }}
                      />
                    </label>
                    <span className="text-[10px] text-stone-400">
                      {normalizeGalleryImages(galleryImages).length} images added
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center space-x-2 mt-4 pl-1">
                <input
                  type="checkbox"
                  id="popular-chk"
                  disabled={isContentLocked}
                  checked={popular}
                  onChange={e => setPopular(e.target.checked)}
                  className="w-4 h-4 text-amber-600 border-stone-300 rounded focus:ring-amber-500"
                />
                <label htmlFor="popular-chk" className={`text-xs font-semibold text-stone-700 select-none ${isContentLocked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>Popular Dish</label>
              </div>

              <div className="col-span-2">
                <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-1">Ingredients (Comma Separated)</label>
                <input
                  type="text"
                  disabled={isContentLocked}
                  value={ingredients}
                  onChange={e => setIngredients(e.target.value)}
                  placeholder="Rosemary, Garlic, Berbere, Olive Oil"
                  className={`w-full text-xs bg-white border border-stone-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-500 ${isContentLocked ? 'opacity-60 cursor-not-allowed bg-stone-100' : ''}`}
                />
              </div>

              <div className="col-span-2 border-t border-stone-200 pt-4 space-y-3">
                <span className="block text-[10px] font-bold text-stone-400 uppercase tracking-widest">Pricing & Availability</span>
                
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-1">Base Price (ETB)</label>
                    <input
                      type="number"
                      step="0.01"
                      disabled={!priceEditable || hasDraftedVariations}
                      value={hasDraftedVariations ? (basePrice || "") : (basePrice || "")}
                      onChange={e => setBasePrice(parseFloat(e.target.value) || 0)}
                      placeholder="e.g. 300"
                      className={`w-full text-xs border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 ${(!priceEditable || hasDraftedVariations) ? 'bg-stone-100 text-stone-500 cursor-not-allowed' : 'bg-white'}`}
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-1">Menu Timing / Schedule</label>
                    <select
                      disabled={isContentLocked}
                      value={menuTiming}
                      onChange={e => {
                        const v = e.target.value;
                        setMenuTiming(v);
                        if (v === "All Day") {
                          setTimingFrom("");
                          setTimingTo("");
                        }
                      }}
                      className={`w-full text-xs bg-white border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 ${isContentLocked ? 'opacity-60 cursor-not-allowed bg-stone-100' : ''}`}
                    >
                      <option value="All Day">All Day</option>
                      <option value="Breakfast Only">Breakfast Only</option>
                      <option value="Lunch Only">Lunch Only</option>
                      <option value="Dinner Only">Dinner Only</option>
                      <option value="Happy Hour">Happy Hour</option>
                    </select>
                  </div>

                  {menuTiming !== "All Day" && (
                    <div className="grid grid-cols-2 gap-3 col-span-2">
                      <div>
                        <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-1">Available From</label>
                        <input
                          type="time"
                          disabled={isContentLocked}
                          value={timingFrom}
                          onChange={e => setTimingFrom(e.target.value)}
                          className={`w-full text-xs bg-white border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 ${isContentLocked ? 'opacity-60 cursor-not-allowed bg-stone-100' : ''}`}
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-1">Available Until</label>
                        <input
                          type="time"
                          disabled={isContentLocked}
                          value={timingTo}
                          onChange={e => setTimingTo(e.target.value)}
                          className={`w-full text-xs bg-white border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 ${isContentLocked ? 'opacity-60 cursor-not-allowed bg-stone-100' : ''}`}
                        />
                      </div>
                    </div>
                  )}

<div className="flex items-center space-x-2 mt-5 pl-1">
                    <input
                      type="checkbox"
                      id="active-toggle-chk"
                      disabled={!canEditAvailability || hasDraftedVariations}
                      checked={hasDraftedVariations ? (currentDefaultVariation ? currentDefaultVariation.isAvailable !== false : true) : isActive}
                      onChange={e => setIsActive(e.target.checked)}
                      className={`w-4 h-4 text-emerald-600 border-stone-300 rounded focus:ring-emerald-500 ${!canEditAvailability || hasDraftedVariations ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                    />
                    <label htmlFor="active-toggle-chk" className={`text-xs font-semibold text-stone-700 select-none ${!canEditAvailability || hasDraftedVariations ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
                      Dish Available (Active)
                    </label>
                  </div>
                  {hasDraftedVariations && (
                    <p className="text-[9px] text-stone-400 -mt-3 pl-1">Mirrors the ★ default variation's availability.</p>
                  )}
                </div>

                <div className="col-span-2 border-t border-stone-100 pt-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="block text-[10px] font-bold text-stone-400 uppercase tracking-widest flex items-center">
                      <Layers className="w-3 h-3 mr-1 text-amber-600" />
                      Variations
                    </span>
                    <button
                      type="button"
                      disabled={isContentLocked}
                      onClick={addVariation}
                      className="flex items-center text-[10px] font-bold text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 px-2.5 py-1 rounded-lg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Plus className="w-3 h-3 mr-1" />
                      Add Variation
                    </button>
                  </div>
                  {variations.length === 0 ? (
                    <p className="text-[11px] text-stone-400">
                      
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {variations.map((v, idx) => {
                        const isDef = !!v.isDefault;
                        return (
                          <div key={v.id || idx} className={`grid grid-cols-[auto_1fr_90px_auto] gap-2 items-start bg-white p-2.5 border rounded-xl ${isDef ? 'border-amber-400 ring-1 ring-amber-400/30' : 'border-stone-200'}`}>
                            <div className="flex flex-col items-center justify-center gap-1 pt-4 pr-0.5">
                              <input
                                type="radio"
                                name="main-variation"
                                disabled={isContentLocked}
                                checked={isDef}
                                onChange={() => setDefaultVariation(idx)}
                                title="Mark as the main (default) variation"
                                className="w-3.5 h-3.5 text-amber-600 border-stone-300 focus:ring-amber-500 cursor-pointer disabled:cursor-not-allowed"
                              />
                              {isDef && (
                                <span className="text-[8px] font-extrabold text-amber-700 uppercase tracking-wide">Main</span>
                              )}
                            </div>
                            <div>
                              <label className="block text-[9px] font-bold text-stone-500 uppercase tracking-wide mb-1">Label *</label>
                              <input
                                type="text"
                                disabled={isContentLocked}
                                value={v.label}
                                onChange={e => updateVariation(idx, { label: e.target.value })}
                                placeholder="e.g. Small / 250ml"
                                className={`w-full text-xs bg-white border border-stone-300 rounded-lg px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-amber-500 ${isContentLocked ? 'opacity-60 cursor-not-allowed bg-stone-100' : ''}`}
                              />
                            </div>
                            <div>
                              <label className="block text-[9px] font-bold text-stone-500 uppercase tracking-wide mb-1">Price (ETB)</label>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                disabled={isContentLocked || !priceEditable}
                                value={String(v.price ?? 0)}
                                onChange={e => updateVariation(idx, { price: parseFloat(e.target.value) || 0 })}
                                placeholder="0.00"
                                className={`w-full text-xs border border-stone-300 rounded-lg px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-amber-500 ${isContentLocked || !priceEditable ? 'bg-stone-100 text-stone-500 cursor-not-allowed' : 'bg-white'}`}
                              />
                            </div>
                            <div className="flex flex-col items-end gap-1.5 pt-4">
                              <label className="flex items-center space-x-1.5 text-[10px] font-semibold text-stone-600 select-none cursor-pointer">
                                <input
                                  type="checkbox"
                                  disabled={isContentLocked}
                                  checked={v.isAvailable !== false}
                                  onChange={e => updateVariation(idx, { isAvailable: e.target.checked })}
                                  className="w-3.5 h-3.5 text-emerald-600 border-stone-300 rounded focus:ring-emerald-500 cursor-pointer"
                                />
                                Available
                              </label>
                              <button
                                type="button"
                                disabled={isContentLocked}
                                onClick={() => removeVariation(idx)}
                                title="Remove this variation"
                                className="p-1 text-stone-400 hover:text-rose-600 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2 pt-2 border-t border-stone-100">
                  <div>
                    <label className="block text-[9px] text-stone-500">Protein</label>
                    <input
                      type="text"
                      disabled={isContentLocked}
                      value={protein}
                      onChange={e => setProtein(e.target.value)}
                      placeholder="28g"
                      className={`w-full text-xs bg-white border border-stone-300 rounded px-2 py-1 focus:outline-none ${isContentLocked ? 'opacity-60 cursor-not-allowed bg-stone-100' : ''}`}
                    />
                  </div>
                  <div>
                    <label className="block text-[9px] text-stone-500">Carbs</label>
                    <input
                      type="text"
                      disabled={isContentLocked}
                      value={carbs}
                      onChange={e => setCarbs(e.target.value)}
                      placeholder="40g"
                      className={`w-full text-xs bg-white border border-stone-300 rounded px-2 py-1 focus:outline-none ${isContentLocked ? 'opacity-60 cursor-not-allowed bg-stone-100' : ''}`}
                    />
                  </div>
                  <div>
                    <label className="block text-[9px] text-stone-500">Fat</label>
                    <input
                      type="text"
                      disabled={isContentLocked}
                      value={fat}
                      onChange={e => setFat(e.target.value)}
                      placeholder="12g"
                      className={`w-full text-xs bg-white border border-stone-300 rounded px-2 py-1 focus:outline-none ${isContentLocked ? 'opacity-60 cursor-not-allowed bg-stone-100' : ''}`}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="flex space-x-2 pt-2 border-t border-stone-200">
              <button
                type="submit"
                disabled={loading}
                className="flex-1 flex items-center justify-center bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold py-2.5 rounded-xl transition-colors cursor-pointer disabled:opacity-50"
              >
                <Save className="w-4 h-4 mr-1.5" />
                {loading ? 'Saving' : 'Save Record'}
              </button>
              <button
                type="button"
                onClick={resetForm}
                className="bg-stone-200 hover:bg-stone-300 text-stone-700 text-xs font-semibold px-4 py-2.5 rounded-xl transition-colors cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>

      {cropFile && (
        <SquareImageCropper
          file={cropFile}
          onCancel={() => setCropFile(null)}
          onConfirm={(dataUrl) => {
            setImage(dataUrl);
            setCropFile(null);
          }}
        />
      )}
    </div>
  );
}
