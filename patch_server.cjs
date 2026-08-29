const fs = require('fs');

let serverFile = fs.readFileSync('server.ts', 'utf-8');

const helperStr = `
async function applyPromo(orderData: any, db: any) {
  try {
    if (orderData.promoCode) {
      const promoRef = doc(db, "promoCodes", orderData.promoCode);
      const promoSnap = await getDoc(promoRef);
      if (promoSnap.exists()) {
        const promo = promoSnap.data();
        await updateDoc(promoRef, { usageCount: (promo.usageCount || 0) + 1 });
      }
    }
  } catch (error) {
    console.error("[PROMO] Error applying promo:", error);
  }
}
`;

serverFile = serverFile.replace('// 0. Category Endpoints', helperStr + '\n// 0. Category Endpoints');

// For Cash Orders
serverFile = serverFile.replace(
  'await setDoc(doc(db, "orders", orderId), newOrder);',
  'await setDoc(doc(db, "orders", orderId), newOrder);\n    await applyPromo(newOrder, db);'
);

// For Chapa Webhook Success
serverFile = serverFile.replace(
  'console.log(`[CHAPA WEBHOOK] Successfully verified payment for order ${txRef}`);',
  'console.log(`[CHAPA WEBHOOK] Successfully verified payment for order ${txRef}`);\n          if (orderData.paymentStatus !== "completed") { await applyPromo(orderData, db); }'
);

// For Chapa Verify Success (in API)
serverFile = serverFile.replace(
  'await updateDoc(orderRef, { \n            paymentStatus: "completed", \n            status: "pending",\n            receipt: receiptInfo\n          });',
  'await updateDoc(orderRef, { \n            paymentStatus: "completed", \n            status: "pending",\n            receipt: receiptInfo\n          });\n          if (orderData.paymentStatus !== "completed") { await applyPromo(orderData, db); }'
);

// Also handle the simulated one just in case
serverFile = serverFile.replace(
  'await updateDoc(orderRef, { \n        paymentStatus: "completed", \n        status: "pending",\n        receipt: receiptInfo\n      });',
  'await updateDoc(orderRef, { \n        paymentStatus: "completed", \n        status: "pending",\n        receipt: receiptInfo\n      });\n      if (orderData.paymentStatus !== "completed") { await applyPromo(orderData, db); }'
);


fs.writeFileSync('server.ts', serverFile);