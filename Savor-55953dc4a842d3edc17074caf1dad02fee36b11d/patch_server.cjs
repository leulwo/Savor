const fs = require('fs');

let serverFile = fs.readFileSync('server.ts', 'utf-8');

const helperStr = `
async function applyLoyaltyAndPromo(orderData: any, db: any) {
  try {
    if (orderData.promoCode) {
      const promoRef = doc(db, "promoCodes", orderData.promoCode);
      const promoSnap = await getDoc(promoRef);
      if (promoSnap.exists()) {
        const promo = promoSnap.data();
        await updateDoc(promoRef, { usageCount: (promo.usageCount || 0) + 1 });
      }
    }
    
    if (orderData.userId && (orderData.pointsUsed > 0 || orderData.pointsEarned > 0)) {
      const userRef = doc(db, "users", orderData.userId);
      const userSnap = await getDoc(userRef);
      if (userSnap.exists()) {
        const user = userSnap.data();
        const currentPoints = user.points || 0;
        const newPoints = currentPoints - (orderData.pointsUsed || 0) + (orderData.pointsEarned || 0);
        await updateDoc(userRef, { points: newPoints });
      }
    }
  } catch (error) {
    console.error("[LOYALTY] Error applying loyalty/promo:", error);
  }
}
`;

serverFile = serverFile.replace('// 0. Category Endpoints', helperStr + '\n// 0. Category Endpoints');

// For Cash Orders
serverFile = serverFile.replace(
  'await setDoc(doc(db, "orders", orderId), newOrder);',
  'await setDoc(doc(db, "orders", orderId), newOrder);\n    await applyLoyaltyAndPromo(newOrder, db);'
);

// For Chapa Webhook Success
serverFile = serverFile.replace(
  'console.log(`[CHAPA WEBHOOK] Successfully verified payment for order ${txRef}`);',
  'console.log(`[CHAPA WEBHOOK] Successfully verified payment for order ${txRef}`);\n          if (orderData.paymentStatus !== "completed") { await applyLoyaltyAndPromo(orderData, db); }'
);

// For Chapa Verify Success (in API)
serverFile = serverFile.replace(
  'await updateDoc(orderRef, { \n            paymentStatus: "completed", \n            status: "pending",\n            receipt: receiptInfo\n          });',
  'await updateDoc(orderRef, { \n            paymentStatus: "completed", \n            status: "pending",\n            receipt: receiptInfo\n          });\n          if (orderData.paymentStatus !== "completed") { await applyLoyaltyAndPromo(orderData, db); }'
);

// Also handle the simulated one just in case
serverFile = serverFile.replace(
  'await updateDoc(orderRef, { \n        paymentStatus: "completed", \n        status: "pending",\n        receipt: receiptInfo\n      });',
  'await updateDoc(orderRef, { \n        paymentStatus: "completed", \n        status: "pending",\n        receipt: receiptInfo\n      });\n      if (orderData.paymentStatus !== "completed") { await applyLoyaltyAndPromo(orderData, db); }'
);

// Inject fields to newOrder for Cash
serverFile = serverFile.replace(
  'flatFee: orderData.flatFee || 0\n    };',
  'flatFee: orderData.flatFee || 0,\n      promoCode: orderData.promoCode || null,\n      discountAmount: orderData.discountAmount || 0,\n      pointsUsed: orderData.pointsUsed || 0,\n      pointsEarned: orderData.pointsEarned || 0\n    };'
);

// Inject fields to newOrder for Chapa
serverFile = serverFile.replace(
  'flatFee: req.body.flatFee || 0\n    };',
  'flatFee: req.body.flatFee || 0,\n      promoCode: req.body.promoCode || null,\n      discountAmount: req.body.discountAmount || 0,\n      pointsUsed: req.body.pointsUsed || 0,\n      pointsEarned: req.body.pointsEarned || 0\n    };'
);


fs.writeFileSync('server.ts', serverFile);
