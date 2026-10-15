import React, { useState, useEffect } from 'react';
import { collection, query, onSnapshot, doc, setDoc, deleteDoc, orderBy } from '../database';
import { db } from '../firebase';
import { PromoCode } from '../types';
import { confirmDialog, toastError } from '../notify';
import { TicketPercent, Plus, Trash2, CheckCircle2, AlertCircle } from 'lucide-react';
import { hasPermission, PermissionMap } from '../permissions';

interface PromoManagerProps {
  can?: (key: string) => boolean;
  permissions?: PermissionMap;
}

export default function PromoManager({ can, permissions }: PromoManagerProps) {
  const [promos, setPromos] = useState<PromoCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  
  const canManage = can ? can("promos.manage") : hasPermission(permissions, "promos.manage");
  
  const [code, setCode] = useState('');
  const [type, setType] = useState<'percentage' | 'fixed'>('percentage');
  const [value, setValue] = useState('');
  const [minOrder, setMinOrder] = useState('');
  const [maxDiscount, setMaxDiscount] = useState('');
  const [expiresAt, setExpiresAt] = useState('');

  useEffect(() => {
    const q = query(collection(db, 'promoCodes'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setPromos((snapshot?.docs || []).map(doc => ({ id: doc.id, ...doc.data() } as PromoCode)));
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code || !value) return;

    confirmDialog(`Create promo code "${code.toUpperCase()}" worth ${type === 'percentage' ? value + '%' : value + ' ETB'}?`, async () => {
      const newPromo: PromoCode = {
        code: code.toUpperCase(),
        type,
        value: Number(value),
        minOrderAmount: minOrder ? Number(minOrder) : undefined,
        maxDiscount: maxDiscount ? Number(maxDiscount) : undefined,
        active: true,
        usageCount: 0,
        expiresAt: expiresAt || undefined,
        createdAt: new Date().toISOString()
      };

      try {
        // Use code as document ID for easy querying
        await setDoc(doc(db, 'promoCodes', newPromo.code), newPromo);
        setShowForm(false);
        setCode('');
        setValue('');
        setMinOrder('');
        setMaxDiscount('');
        setExpiresAt('');
      } catch (error) {
        console.error("Error creating promo:", error);
        toastError("Failed to create promo code");
      }
    }, null, "Create");
  };

  const handleDelete = async (id: string) => {
    confirmDialog('Are you sure you want to delete this promo code?', async () => {
      try {
        await deleteDoc(doc(db, 'promoCodes', id));
      } catch (error) {
        console.error("Error deleting promo:", error);
        toastError("Failed to delete promo code");
      }
    }, null, "Delete");
  };

  const toggleStatus = async (promo: PromoCode) => {
    if (!promo.id) return;
    const action = promo.active ? "deactivate" : "activate";
    confirmDialog(`Are you sure you want to ${action} promo code "${promo.id}"? Customers ${promo.active ? 'will no longer be able to use' : 'will now be able to use'} this code.`, async () => {
      try {
        await setDoc(doc(db, 'promoCodes', promo.id), { active: !promo.active }, { merge: true });
      } catch (error) {
        console.error("Error toggling status:", error);
        toastError("Failed to update promo code status");
      }
    }, null, action === "activate" ? "Activate" : "Deactivate");
  };

  if (loading) return <div>Loading promotions...</div>;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold text-stone-900">Promo Codes</h2>
          <p className="text-sm text-stone-500">Manage discount codes for your customers</p>
        </div>
        {canManage && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="bg-amber-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-amber-700 flex items-center transition-colors"
          >
            <Plus className="w-4 h-4 mr-2" />
            New Promo
          </button>
        )}
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm space-y-4">
          <h3 className="font-semibold text-stone-900">Create New Promo Code</h3>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Code</label>
              <input
                required
                type="text"
                placeholder="e.g. SUMMER10"
                value={code}
                onChange={e => setCode(e.target.value.toUpperCase().replace(/\s+/g, ''))}
                className="w-full border border-stone-200 rounded-xl px-4 py-2 text-sm focus:ring-2 focus:ring-amber-500 outline-none"
              />
            </div>
            
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">Type</label>
                <select
                  value={type}
                  onChange={e => setType(e.target.value as any)}
                  className="w-full border border-stone-200 rounded-xl px-4 py-2 text-sm focus:ring-2 focus:ring-amber-500 outline-none"
                >
                  <option value="percentage">Percentage (%)</option>
                  <option value="fixed">Fixed Amount (ETB)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">Value</label>
                <input
                  required
                  type="number"
                  min="1"
                  value={value}
                  onChange={e => setValue(e.target.value)}
                  className="w-full border border-stone-200 rounded-xl px-4 py-2 text-sm focus:ring-2 focus:ring-amber-500 outline-none"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Min Order Amount (ETB, optional)</label>
              <input
                type="number"
                min="0"
                value={minOrder}
                onChange={e => setMinOrder(e.target.value)}
                className="w-full border border-stone-200 rounded-xl px-4 py-2 text-sm focus:ring-2 focus:ring-amber-500 outline-none"
              />
            </div>

            {type === 'percentage' && (
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">Max Discount (ETB, optional)</label>
                <input
                  type="number"
                  min="0"
                  value={maxDiscount}
                  onChange={e => setMaxDiscount(e.target.value)}
                  className="w-full border border-stone-200 rounded-xl px-4 py-2 text-sm focus:ring-2 focus:ring-amber-500 outline-none"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Expiry Date (optional)</label>
              <input
                type="date"
                value={expiresAt}
                onChange={e => setExpiresAt(e.target.value)}
                className="w-full border border-stone-200 rounded-xl px-4 py-2 text-sm focus:ring-2 focus:ring-amber-500 outline-none"
              />
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              className="bg-stone-900 text-white px-6 py-2 rounded-xl text-sm font-medium hover:bg-stone-800 transition-colors"
            >
              Create Promo
            </button>
          </div>
        </form>
      )}

      <div className="bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-stone-50 text-stone-500">
            <tr>
              <th className="px-6 py-4 font-medium">Code</th>
              <th className="px-6 py-4 font-medium">Discount</th>
              <th className="px-6 py-4 font-medium">Constraints</th>
              <th className="px-6 py-4 font-medium">Usage</th>
              <th className="px-6 py-4 font-medium">Status</th>
              <th className="px-6 py-4 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {(!promos || promos.length === 0) ? (
              <tr>
                <td colSpan={6} className="px-6 py-8 text-center text-stone-500">
                  No promo codes created yet.
                </td>
              </tr>
            ) : (promos || []).map(promo => (
              <tr key={promo.id}>
                <td className="px-6 py-4 font-medium text-stone-900 flex items-center">
                  <TicketPercent className="w-4 h-4 mr-2 text-amber-600" />
                  {promo.code}
                </td>
                <td className="px-6 py-4 text-stone-600">
                  {promo.type === 'percentage' ? `${promo.value}% off` : `${promo.value} ETB off`}
                </td>
                <td className="px-6 py-4 text-xs text-stone-500">
                  {promo.minOrderAmount && <div>Min: {promo.minOrderAmount} ETB</div>}
                  {promo.maxDiscount && <div>Max: {promo.maxDiscount} ETB</div>}
                  {promo.expiresAt && <div>Expires: {new Date(promo.expiresAt).toLocaleDateString()}</div>}
                  {!promo.minOrderAmount && !promo.maxDiscount && !promo.expiresAt && <span className="text-stone-400">None</span>}
                </td>
                <td className="px-6 py-4 text-stone-600">
                  {promo.usageCount} uses
                </td>
                <td className="px-6 py-4">
                  {canManage ? (
                    <button
                      onClick={() => toggleStatus(promo)}
                      className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                        promo.active 
                          ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' 
                          : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                      }`}
                    >
                      {promo.active ? 'Active' : 'Inactive'}
                    </button>
                  ) : (
                    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${promo.active ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-100 text-stone-600'}`}>
                      {promo.active ? 'Active' : 'Inactive'}
                    </span>
                  )}
                </td>
                <td className="px-6 py-4 text-right">
                  {canManage && (
                    <button
                      onClick={() => promo.id && handleDelete(promo.id)}
                      className="p-2 text-rose-500 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
