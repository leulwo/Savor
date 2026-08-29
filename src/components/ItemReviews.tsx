import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, orderBy, onSnapshot, doc, setDoc } from 'firebase/firestore';
import { Review } from '../types';
import { Star, User } from 'lucide-react';
import { toastError } from '../notify';

interface ItemReviewsProps {
  menuItemId: string;
  user: any;
}

export default function ItemReviews({ menuItemId, user }: ItemReviewsProps) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const q = query(
      collection(db, 'reviews'),
      where('menuItemId', '==', menuItemId),
      orderBy('createdAt', 'desc')
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const revData = (snapshot?.docs || []).map(doc => ({ id: doc.id, ...doc.data() } as Review));
      setReviews(revData);
    });

    return () => unsubscribe();
  }, [menuItemId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setIsSubmitting(true);
    
    try {
      const reviewRef = doc(collection(db, 'reviews'));
      await setDoc(reviewRef, {
        menuItemId,
        userId: user.uid,
        customerName: user.displayName || 'Anonymous',
        rating,
        comment,
        createdAt: new Date().toISOString()
      });
      setRating(5);
      setComment('');
    } catch (error) {
      console.error("Failed to post review:", error);
      toastError("Failed to post review.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const averageRating = (reviews && reviews.length > 0) 
    ? ((reviews || []).reduce((acc, r) => acc + (r?.rating || 0), 0) / reviews.length).toFixed(1)
    : '0.0';

  return (
    <div className="space-y-4 pt-4 border-t border-stone-200">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold text-stone-900 font-serif">Customer Reviews</h4>
        <div className="flex items-center space-x-1 text-sm font-bold text-stone-800">
          <Star className="w-4 h-4 text-amber-500 fill-amber-500" />
          <span>{averageRating}</span>
          <span className="text-xs text-stone-400 font-normal">({(reviews || []).length})</span>
        </div>
      </div>

      {user ? (
        <form onSubmit={handleSubmit} className="bg-stone-50 p-4 rounded-xl border border-stone-200 space-y-3">
          <div>
            <label className="block text-[11px] font-bold text-stone-500 uppercase tracking-wide mb-1">Your Rating</label>
            <div className="flex space-x-1">
              {[1, 2, 3, 4, 5].map(star => (
                <button
                  key={star}
                  type="button"
                  onClick={() => setRating(star)}
                  className="p-1 hover:scale-110 transition-transform cursor-pointer"
                >
                  <Star className={`w-5 h-5 ${star <= rating ? 'text-amber-500 fill-amber-500' : 'text-stone-300'}`} />
                </button>
              ))}
            </div>
          </div>
          <div>
            <textarea
              required
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder="What did you think about this dish?"
              rows={2}
              className="w-full text-xs bg-white border border-stone-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={isSubmitting || !comment.trim()}
              className="bg-stone-900 hover:bg-amber-600 text-white font-bold py-1.5 px-4 rounded-lg text-xs transition-colors disabled:opacity-50 cursor-pointer"
            >
              {isSubmitting ? 'Posting...' : 'Post Review'}
            </button>
          </div>
        </form>
      ) : (
        <div className="bg-amber-50/50 p-3 rounded-lg border border-amber-100 flex items-start space-x-2">
          <User className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-800">Please sign in to leave a review.</p>
        </div>
      )}

      <div className="space-y-3 max-h-64 overflow-y-auto pr-2">
        {(!reviews || reviews.length === 0) ? (
          <p className="text-[11px] text-stone-500 text-center py-4">No reviews yet. Be the first to review!</p>
        ) : (
          (reviews || []).map(review => (
            <div key={review.id} className="bg-white p-3 rounded-xl border border-stone-100 shadow-xs">
              <div className="flex justify-between items-start mb-1">
                <span className="text-[11px] font-bold text-stone-900">{review.customerName}</span>
                <div className="flex space-x-0.5">
                  {[...Array(5)].map((_, i) => (
                    <Star key={i} className={`w-3 h-3 ${i < review.rating ? 'text-amber-500 fill-amber-500' : 'text-stone-200'}`} />
                  ))}
                </div>
              </div>
              <p className="text-[11px] text-stone-600">{review.comment}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
