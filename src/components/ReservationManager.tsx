import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, orderBy, onSnapshot, doc, updateDoc } from 'firebase/firestore';
import { Reservation } from '../types';
import { CalendarDays, CheckCircle, XCircle, Clock, Users, Mail, Phone, User } from 'lucide-react';
import { toastError, confirmDialog } from '../notify';
import { hasPermission, PermissionMap } from '../permissions';

interface ReservationManagerProps {
  can?: (key: string) => boolean;
  permissions?: PermissionMap;
}

export default function ReservationManager({ can, permissions }: ReservationManagerProps) {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);

  const canManage = can ? can("reservations.manage") : hasPermission(permissions, "reservations.manage");

  useEffect(() => {
    // Single-field or unsorted query to avoid needing a Firestore composite index for (date desc, time asc)
    const q = query(collection(db, 'reservations'));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        try {
          const resData = (snapshot?.docs || []).map(doc => ({ id: doc.id, ...doc.data() } as Reservation));
          // Sort in memory by date descending, then time ascending with type safety checking
          resData.sort((a, b) => {
            const dateA = typeof a.date === 'string' ? a.date : '';
            const dateB = typeof b.date === 'string' ? b.date : '';
            const dateCompare = dateB.localeCompare(dateA);
            if (dateCompare !== 0) return dateCompare;

            const timeA = typeof a.time === 'string' ? a.time : '';
            const timeB = typeof b.time === 'string' ? b.time : '';
            return timeA.localeCompare(timeB);
          });
          setReservations(resData);
          setLoading(false);
        } catch (e) {
          console.error("Error processing reservations data:", e);
          setLoading(false);
        }
      },
      (error) => {
        console.error("Error fetching reservations:", error);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, []);

  const updateStatus = async (id: string, newStatus: 'confirmed' | 'cancelled') => {
    confirmDialog(`Mark this reservation as "${newStatus.toUpperCase()}"?`, async () => {
      try {
        await updateDoc(doc(db, 'reservations', id), {
          status: newStatus
        });
      } catch (error) {
        console.error("Failed to update reservation status:", error);
        toastError("Failed to update status.");
      }
    }, null, newStatus === "confirmed" ? "Confirm" : "Cancel");
  };

  if (loading) {
    return <div className="p-8 text-center text-stone-500">Loading reservations...</div>;
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-stone-200 overflow-hidden">
      <div className="p-6 border-b border-stone-100 bg-stone-50 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="bg-amber-100 p-2 rounded-lg text-amber-700">
            <CalendarDays className="w-5 h-5" />
          </div>
          <h2 className="font-serif text-xl font-bold text-stone-900">Table Reservations</h2>
        </div>
      </div>

      <div className="divide-y divide-stone-100">
        {(!reservations || reservations.length === 0) ? (
          <div className="p-12 text-center text-stone-500">
            <CalendarDays className="w-12 h-12 mx-auto mb-3 text-stone-300 stroke-1" />
            <p>No reservations found.</p>
          </div>
        ) : (
          (reservations || []).map(res => (
            <div key={res.id} className="p-6 hover:bg-stone-50 transition-colors flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="space-y-2">
                <div className="flex items-center space-x-3">
                  <h3 className="font-bold text-stone-900">{res.customerName}</h3>
                  <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${res.status === 'confirmed' ? 'bg-green-100 text-green-700' :
                      res.status === 'cancelled' ? 'bg-red-100 text-red-700' :
                        'bg-amber-100 text-amber-700'
                    }`}>
                    {res.status}
                  </span>
                </div>

                <div className="flex flex-wrap gap-y-2 gap-x-4 text-xs text-stone-600">
                  <div className="flex items-center space-x-1.5">
                    <CalendarDays className="w-3.5 h-3.5 text-stone-400" />
                    <span>{res.date}</span>
                  </div>
                  <div className="flex items-center space-x-1.5">
                    <Clock className="w-3.5 h-3.5 text-stone-400" />
                    <span>{res.time}</span>
                  </div>
                  <div className="flex items-center space-x-1.5">
                    <Users className="w-3.5 h-3.5 text-stone-400" />
                    <span>{res.partySize} {res.partySize === 1 ? 'Person' : 'People'}</span>
                  </div>
                </div>

                {res.notes && (
                  <div className="mt-2 text-xs text-stone-600 bg-stone-100 p-2 rounded border border-stone-200">
                    <span className="font-semibold text-stone-800">Notes:</span> {res.notes}
                  </div>
                )}

                <div className="flex flex-wrap gap-y-2 gap-x-4 text-xs text-stone-500 mt-2">
                  <div className="flex items-center space-x-1.5">
                    <Mail className="w-3.5 h-3.5 text-stone-400" />
                    <a href={`mailto:${res.customerEmail}`} className="hover:text-amber-600 underline">{res.customerEmail}</a>
                  </div>
                  {res.customerPhone && (
                    <div className="flex items-center space-x-1.5">
                      <Phone className="w-3.5 h-3.5 text-stone-400" />
                      <a href={`tel:${res.customerPhone}`} className="hover:text-amber-600 underline">{res.customerPhone}</a>
                    </div>
                  )}
                  {res.userId && (
                    <div className="flex items-center space-x-1.5 text-amber-600">
                      <User className="w-3.5 h-3.5" />
                      <span>Registered User</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 mt-2 md:mt-0">
                {canManage && res.status === 'pending' && (
                  <>
                    <button
                      onClick={() => updateStatus(res.id!, 'confirmed')}
                      className="flex items-center space-x-1.5 px-4 py-2 bg-stone-900 hover:bg-green-600 text-white text-xs font-bold rounded-lg transition-colors cursor-pointer"
                    >
                      <CheckCircle className="w-3.5 h-3.5" />
                      <span>Confirm</span>
                    </button>
                    <button
                      onClick={() => updateStatus(res.id!, 'cancelled')}
                      className="flex items-center space-x-1.5 px-4 py-2 border border-stone-300 hover:bg-red-50 hover:text-red-600 hover:border-red-200 text-stone-600 text-xs font-bold rounded-lg transition-colors cursor-pointer"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      <span>Decline</span>
                    </button>
                  </>
                )}
                {canManage && res.status === 'confirmed' && (
                  <button
                    onClick={() => updateStatus(res.id!, 'cancelled')}
                    className="flex items-center space-x-1.5 px-4 py-2 border border-stone-300 hover:bg-red-50 hover:text-red-600 hover:border-red-200 text-stone-600 text-xs font-bold rounded-lg transition-colors cursor-pointer"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    <span>Cancel</span>
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
