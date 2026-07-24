/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { MenuItem } from "../types";
import { Plus, Edit2, Trash2, Save, X, Utensils, Tag, Clock } from "lucide-react";
import { db } from "../firebase";
import { doc, setDoc, deleteDoc, collection, getDocs } from "firebase/firestore";

interface MenuManagerProps {
  onMenuUpdated: () => void;
  menu: MenuItem[];
  userRole?: string | null;
}

export default function MenuManager({ menu, onMenuUpdated, userRole }: MenuManagerProps) {
  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

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
        const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) as {id: string, name: string}[];
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
  const [popular, setPopular] = useState(false);
  const [prepTime, setPrepTime] = useState("");
  const [ingredients, setIngredients] = useState("");
  const [protein, setProtein] = useState("");
  const [carbs, setCarbs] = useState("");
  const [fat, setFat] = useState("");

  // New properties
  const [basePrice, setBasePrice] = useState<number>(0);
  const [taxRate, setTaxRate] = useState<string>("Food Tax (15%)");
  const [taxRatePercent, setTaxRatePercent] = useState<number>(15);
  const [isActive, setIsActive] = useState<boolean>(true);
  const [menuTiming, setMenuTiming] = useState<string>("All Day");
  const [galleryImages, setGalleryImages] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");

  const resetForm = () => {
    setId("");
    setName("");
    setDescription("");
    setPrice(0);
    setCategory(categories.length > 0 ? categories[0].id : "starters");
    setSelectedCategories([]);
    setSelectedPromoStickers([]);
    setImage("");
    setGalleryImages("");
    setPopular(false);
    setPrepTime("15 mins");
    setIngredients("");
    setProtein("");
    setCarbs("");
    setFat("");
    setBasePrice(0);
    setTaxRate("Food Tax (15%)");
    setTaxRatePercent(15);
    setIsActive(true);
    setMenuTiming("All Day");
    setSelectedItem(null);
    setIsEditing(false);
  };

  const loadItemToForm = (item: MenuItem) => {
    setSelectedItem(item);
    setId(item.id);
    setName(item.name);
    setDescription(item.description);
    setPrice(item.price);
    setCategory(item.category);
    setSelectedCategories(item.categories || [item.category]);
    setSelectedPromoStickers(item.promoStickers || []);
    setImage(item.image);
    setGalleryImages(item.galleryImages ? item.galleryImages.join(", ") : "");
    setPopular(!!item.popular);
    setPrepTime(item.prepTime || "15 mins");
    setIngredients(item.ingredients ? item.ingredients.join(", ") : "");
    setProtein(item.nutrition?.protein || "");
    setCarbs(item.nutrition?.carbs || "");
    setFat(item.nutrition?.fat || "");
    setBasePrice(item.basePrice !== undefined ? item.basePrice : item.price);
    setTaxRate(item.taxRate || "Food Tax (15%)");
    setTaxRatePercent(item.taxRatePercent !== undefined ? item.taxRatePercent : 15);
    setIsActive(item.isActive !== false);
    setMenuTiming(item.menuTiming || "All Day");
    setIsEditing(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || price <= 0) {
      setMessage({ type: 'error', text: 'Name and a valid positive price are required.' });
      return;
    }

    setLoading(true);
    setMessage(null);

    const parsedIngredients = ingredients
      .split(",")
      .map(i => i.trim())
      .filter(i => i.length > 0);

    const parsedGalleryImages = galleryImages
      .split(",")
      .map(url => url.trim())
      .filter(url => url.length > 0);

    const itemId = id || Math.random().toString(36).substring(2, 11);

    const payload = {
      id: itemId,
      name,
      description,
      price: parseFloat(price.toString()),
      category: selectedCategories.length > 0 ? selectedCategories[0] : category,
      categories: selectedCategories.length > 0 ? selectedCategories : [category],
      promoStickers: selectedPromoStickers,
      image: image || "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&q=80&w=600",
      galleryImages: parsedGalleryImages,
      popular,
      prepTime,
      ingredients: parsedIngredients,
      nutrition: {
        protein,
        carbs,
        fat
      },
      basePrice: parseFloat(basePrice.toString()) || parseFloat(price.toString()),
      taxRate,
      taxRatePercent: parseFloat(taxRatePercent.toString()) || 0,
      isActive,
      menuTiming
    };

    try {
      await setDoc(doc(db, "menu", itemId), payload);
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
    if (!window.confirm("Are you sure you want to delete this menu item?")) return;
    
    setLoading(true);
    try {
      await deleteDoc(doc(db, "menu", itemId));
      setMessage({ type: 'success', text: 'Item successfully deleted.' });
      onMenuUpdated();
      resetForm();
    } catch (err: any) {
      setMessage({ type: 'error', text: `Connection error: ${err.message}` });
    } finally {
      setLoading(false);
    }
  };

  const filteredMenu = menu.filter(item => 
    item.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    (item.description && item.description.toLowerCase().includes(searchQuery.toLowerCase())) ||
    item.category.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div id="menu-manager-admin" className="bg-white border border-stone-200 rounded-2xl p-6 shadow-md font-sans">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-stone-100 pb-4 mb-6">
        <div>
          <h3 className="font-serif text-xl font-bold text-stone-900">Customizer & Template Editor</h3>
          <p className="text-xs text-stone-500">Edit pre-made restaurant items or add custom culinary delights into the database.</p>
        </div>
        {!isEditing && (
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
              <span>Database Records ({filteredMenu.length} of {menu.length})</span>
              <span className="text-[10px] bg-stone-100 text-stone-600 px-2 py-0.5 rounded-full font-mono font-bold">LIVE SYNC</span>
            </div>
            <input
              type="text"
              placeholder="🔍 Search dishes by name, description, category..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full text-xs bg-white border border-stone-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-amber-500 font-medium"
            />
          </div>
          {filteredMenu.map(item => (
            <div key={item.id} className="flex items-center justify-between p-3 border border-stone-150 rounded-xl hover:bg-stone-50 transition-colors">
              <div className="flex items-center space-x-3 truncate">
                <img src={item.image} alt={item.name} className="w-11 h-11 rounded-lg object-cover bg-stone-100 border border-stone-200 flex-shrink-0" />
                <div className="truncate">
                  <h4 className="font-serif font-semibold text-stone-900 text-sm">{item.name}</h4>
                  <p className="text-xs text-stone-500 font-medium flex items-center mt-0.5 capitalize">
                    <Tag className="w-3 h-3 mr-1 text-amber-600" />
                    {categories.find(c => c.id === item.category)?.name || item.category} • <span className="text-emerald-700 font-bold ml-1">{item.price.toFixed(2)} ETB</span>
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-1.5">
                <button
                  onClick={() => loadItemToForm(item)}
                  className="p-2 hover:bg-stone-100 rounded-lg text-stone-500 hover:text-stone-950 transition-colors cursor-pointer"
                  title="Edit item parameters"
                >
                  <Edit2 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleDelete(item.id)}
                  className="p-2 hover:bg-rose-50 rounded-lg text-stone-400 hover:text-rose-600 transition-colors cursor-pointer"
                  title="Remove from database"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
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
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g., Spicy Doro Wat Croquettes"
                  className="w-full text-xs bg-white border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-amber-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-1">Price (ETB) *</label>
                <input
                  type="number"
                  step="0.01"
                  required
                  disabled={userRole === 'kitchen'}
                  value={price || ""}
                  onChange={e => {
                    const val = parseFloat(e.target.value) || 0;
                    setPrice(val);
                    if (!basePrice || basePrice === 0) {
                      setBasePrice(val);
                    }
                  }}
                  placeholder="320"
                  className={`w-full text-xs border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 ${userRole === 'kitchen' ? 'bg-stone-100 text-stone-500 cursor-not-allowed' : 'bg-white'}`}
                />
              </div>

              <div className="col-span-2">
                <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-2">Categories * (Select at least one)</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {categories.map(c => (
                    <label key={c.id} className="flex items-center space-x-2 bg-stone-50 border border-stone-200 p-2 rounded-lg cursor-pointer hover:bg-stone-100 transition-colors">
                      <input
                        type="checkbox"
                        checked={selectedCategories.includes(c.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedCategories([...selectedCategories, c.id]);
                          } else {
                            setSelectedCategories(selectedCategories.filter(cat => cat !== c.id));
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
                    <label key={sticker} className="flex items-center space-x-2 bg-stone-50 border border-stone-200 p-2 rounded-lg cursor-pointer hover:bg-stone-100 transition-colors">
                      <input
                        type="checkbox"
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
                  onChange={e => setDescription(e.target.value)}
                  placeholder="A detailed description of ingredients, baking methods..."
                  rows={2}
                  className="w-full text-xs bg-white border border-stone-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
              </div>

              <div className="col-span-2">
                <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-1">Image (URL or Local Upload)</label>
                <div className="space-y-2 bg-white p-3 border border-stone-250 rounded-xl">
                  <input
                    type="url"
                    value={image}
                    onChange={e => setImage(e.target.value)}
                    placeholder="Main image URL: https://images.unsplash.com/..."
                    className="w-full text-xs bg-stone-50 border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-amber-500"
                  />
                  <div className="flex items-center justify-between">
                    <label className="flex items-center justify-center px-3 py-1.5 border border-stone-300 rounded-lg shadow-xs text-xs font-semibold text-stone-700 bg-white hover:bg-stone-50 cursor-pointer transition-all focus-within:ring-2 focus-within:ring-amber-500">
                      <span>Upload Local Photo</span>
                      <input
                        type="file"
                        accept="image/*"
                        className="sr-only"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            const reader = new FileReader();
                            reader.onloadend = () => {
                              if (typeof reader.result === 'string') {
                                setImage(reader.result);
                              }
                            };
                            reader.readAsDataURL(file);
                          }
                        }}
                      />
                    </label>
                    {image && (
                      <div className="flex items-center space-x-2">
                        <img src={image} alt="Preview" className="w-8 h-8 rounded-lg object-cover border border-stone-200" />
                        <span className="text-[10px] text-emerald-600 font-bold uppercase tracking-wider">
                          {image.startsWith('data:') ? 'Local Selected' : 'Custom URL'}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="col-span-2">
                <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-1">Additional Gallery Images</label>
                <div className="space-y-2 bg-white p-3 border border-stone-250 rounded-xl">
                  <textarea
                    value={galleryImages}
                    onChange={e => setGalleryImages(e.target.value)}
                    placeholder="Provide URLs (comma separated) or use the upload button..."
                    rows={2}
                    className="w-full text-xs bg-stone-50 border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500"
                  />
                  <div className="flex items-center justify-between mt-2">
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
                      {galleryImages.split(',').filter(s => s.trim().length > 0).length} images added
                    </span>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-1">Preparation Time</label>
                <input
                  type="text"
                  value={prepTime}
                  onChange={e => setPrepTime(e.target.value)}
                  placeholder="15 mins"
                  className="w-full text-xs bg-white border border-stone-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
              </div>

              <div className="flex items-center space-x-2 mt-4 pl-1">
                <input
                  type="checkbox"
                  id="popular-chk"
                  checked={popular}
                  onChange={e => setPopular(e.target.checked)}
                  className="w-4 h-4 text-amber-600 border-stone-300 rounded focus:ring-amber-500"
                />
                <label htmlFor="popular-chk" className="text-xs font-semibold text-stone-700 select-none cursor-pointer">Popular/Specialty Dish</label>
              </div>

              <div className="col-span-2">
                <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-1">Ingredients (Comma Separated)</label>
                <input
                  type="text"
                  value={ingredients}
                  onChange={e => setIngredients(e.target.value)}
                  placeholder="Rosemary, Garlic, Berbere, Olive Oil"
                  className="w-full text-xs bg-white border border-stone-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
              </div>

              <div className="col-span-2 border-t border-stone-200 pt-4 space-y-3">
                <span className="block text-[10px] font-bold text-stone-400 uppercase tracking-widest">Pricing, Tax & Availability</span>
                
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-1">Base Price (ETB)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={basePrice || ""}
                      onChange={e => setBasePrice(parseFloat(e.target.value) || 0)}
                      placeholder="e.g. 300"
                      className="w-full text-xs bg-white border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-1">Tax Percent (%)</label>
                    <input
                      type="number"
                      step="0.1"
                      value={taxRatePercent || ""}
                      onChange={e => setTaxRatePercent(parseFloat(e.target.value) || 0)}
                      placeholder="e.g. 15"
                      className="w-full text-xs bg-white border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-1">Menu Timing / Schedule</label>
                    <select
                      value={menuTiming}
                      onChange={e => setMenuTiming(e.target.value)}
                      className="w-full text-xs bg-white border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500"
                    >
                      <option value="All Day">All Day</option>
                      <option value="Breakfast Only">Breakfast Only</option>
                      <option value="Lunch Only">Lunch Only</option>
                      <option value="Dinner Only">Dinner Only</option>
                      <option value="Happy Hour">Happy Hour</option>
                    </select>
                  </div>

                  <div className="flex items-center space-x-2 mt-5 pl-1">
                    <input
                      type="checkbox"
                      id="active-toggle-chk"
                      checked={isActive}
                      onChange={e => setIsActive(e.target.checked)}
                      className="w-4 h-4 text-emerald-600 border-stone-300 rounded focus:ring-emerald-500 cursor-pointer"
                    />
                    <label htmlFor="active-toggle-chk" className="text-xs font-semibold text-stone-700 select-none cursor-pointer">
                      Dish Available (Active)
                    </label>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 pt-2 border-t border-stone-100">
                  <div>
                    <label className="block text-[9px] text-stone-500">Protein</label>
                    <input
                      type="text"
                      value={protein}
                      onChange={e => setProtein(e.target.value)}
                      placeholder="28g"
                      className="w-full text-xs bg-white border border-stone-300 rounded px-2 py-1 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[9px] text-stone-500">Carbs</label>
                    <input
                      type="text"
                      value={carbs}
                      onChange={e => setCarbs(e.target.value)}
                      placeholder="40g"
                      className="w-full text-xs bg-white border border-stone-300 rounded px-2 py-1 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[9px] text-stone-500">Fat</label>
                    <input
                      type="text"
                      value={fat}
                      onChange={e => setFat(e.target.value)}
                      placeholder="12g"
                      className="w-full text-xs bg-white border border-stone-300 rounded px-2 py-1 focus:outline-none"
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
                {loading ? 'Saving to Database...' : 'Save Record'}
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
    </div>
  );
}
