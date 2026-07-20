/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import axios from "axios";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, doc, getDocs, getDoc, setDoc, updateDoc, deleteDoc, query, orderBy } from "firebase/firestore";
import fs from "fs";

dotenv.config();

let firebaseConfig = {};
try {
  const configRaw = fs.readFileSync(path.join(process.cwd(), "firebase-applet-config.json"), "utf-8");
  firebaseConfig = JSON.parse(configRaw);
} catch (e) {
  console.warn("Could not load firebase-applet-config.json", e);
}

const appFirebase = initializeApp(firebaseConfig);
const db = getFirestore(appFirebase, (firebaseConfig as any).firestoreDatabaseId || "ai-studio-restaurantwebsit-315fb01e-8f08-42d3-b0aa-03636feabfef");
// Note: In typical GCP containers, ADC defaults to default DB. If you created a custom DB ID,
// you might need `admin.firestore({ databaseId: 'ai-studio-restaurantwebsit-315fb01e-8f08-42d3-b0aa-03636feabfef' })`.
// Wait, the documentation for custom DB in admin SDK is tricky, we can just fetch collections.
// Actually, `admin.firestore()` will hit the default DB unless initialized with custom config.
// Let's use the default DB for the backend or specify the databaseId if possible.
// Wait, AI Studio Firebase sets up the DB. I'll rely on the client SDK reading from the right one, 
// and the server syncing with the default ADC (which usually works out of the box in AI Studio).

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Helper to trigger Shipday order creation
async function triggerShipday(orderId: string, db: any, deliveryMinutes?: number) {
  try {
    // Fetch settings first to get API Key and Pickup Lead Time
    const settingsSnap = await getDoc(doc(db, "settings", "checkout"));
    const settings = settingsSnap.exists() ? settingsSnap.data() : {};
    
    const shipdayKey = process.env.SHIPDAY_API_KEY || settings.shipdayApiKey;
    const pickupLeadTime = settings.shipdayPickupMinutes || 10;
    
    if (!shipdayKey) {
      console.warn(`[SHIPDAY] Skip: API key not configured for order ${orderId}`);
      return;
    }

    const orderRef = doc(db, "orders", orderId);
    const docSnap = await getDoc(orderRef);
    if (!docSnap.exists()) return;

    const orderData = docSnap.data();
    
    console.log(`[SHIPDAY] Triggering order ${orderId} (Delivery: ${deliveryMinutes || 'auto'}, Pickup Lead: ${pickupLeadTime})...`);

    const payload: any = {
      orderNumber: orderId,
      customerName: orderData.customerName,
      customerAddress: orderData.googleMapsAddress || orderData.blockNumber || "No address provided",
      customerEmail: orderData.customerEmail,
      customerPhoneNumber: orderData.customerPhone,
      restaurantName: "Savory VPS",
      restaurantAddress: "Addis Ababa, Ethiopia",
      orderItems: orderData.items.map((item: any) => ({
        name: item.menuItem?.name || item.name || "Menu Item",
        unitPrice: item.menuItem?.price || item.price || 0,
        quantity: item.quantity || 1
      })),
      totalOrderCost: orderData.total,
      deliveryFee: orderData.flatFee || 0,
      tax: orderData.serviceTax || 0,
      paymentMethod: orderData.paymentMethod === 'cash' ? 'cash' : 'credit_card',
      paymentType: orderData.paymentMethod === 'cash' ? 'cash' : 'credit_card'
    };

    const shipdayResponse = await axios.post(
      "https://api.shipday.com/orders", 
      payload,
      {
        headers: {
          "Authorization": "Basic " + shipdayKey,
          "Content-Type": "application/json"
        }
      }
    );

    const data = shipdayResponse.data;
    if (data && data.orderId) {
      await updateDoc(orderRef, {
        shipdayOrderId: data.orderId,
        shipdayStatus: "created",
        shipdayTrackingLink: data.trackingLink || data.shortTrackingLink || null,
        shipdaySyncedAt: new Date().toISOString()
      });
      console.log(`[SHIPDAY] Order ${orderId} synced successfully (Shipday ID: ${data.orderId})`);
    }
  } catch (error: any) {
    console.error(`[SHIPDAY] Error in triggerShipday for ${orderId}:`, error.response?.data || error.message);
  }
}


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

// 0. Category Endpoints
app.get("/api/categories", async (req, res) => {
  try {
    const snapshot = await getDocs(collection(db, "categories"));
    const categories = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(categories);
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch categories", details: error.message });
  }
});

app.post("/api/categories", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: "Category name is required." });
    }
    
    const id = name.toLowerCase().replace(/\s+/g, '-');
    await setDoc(doc(db, "categories", id), { name });
    
    const snapshot = await getDocs(collection(db, "categories"));
    const categories = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, categories });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to create category", details: error.message });
  }
});

app.delete("/api/categories/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await deleteDoc(doc(db, "categories", id));
    
    const snapshot = await getDocs(collection(db, "categories"));
    const categories = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, categories });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to delete category", details: error.message });
  }
});

// 1. Menu Endpoints
app.get("/api/menu", async (req, res) => {
  try {
    const snapshot = await getDocs(collection(db, "menu"));
    const menu = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(menu);
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch menu items", details: error.message });
  }
});

app.post("/api/menu", async (req, res) => {
  try {
    const item = req.body;
    if (!item.name || !item.price || !item.category) {
      return res.status(400).json({ error: "Name, price, and category are required." });
    }

    const itemId = item.id || Math.random().toString(36).substring(2, 11);
    const newItem = {
      ...item,
      id: itemId,
      prepTime: item.prepTime || "15 mins",
      ingredients: item.ingredients || [],
      nutrition: item.nutrition || { protein: "0g", carbs: "0g", fat: "0g" },
      basePrice: item.basePrice !== undefined ? item.basePrice : item.price,
      taxRate: item.taxRate || "Food Tax (15%)",
      taxRatePercent: item.taxRatePercent !== undefined ? item.taxRatePercent : 15,
      isActive: item.isActive !== false,
      menuTiming: item.menuTiming || "All Day",
      categories: item.categories || [item.category],
      promoStickers: item.promoStickers || [],
      galleryImages: item.galleryImages || []
    };
    
    await setDoc(doc(db, "menu", itemId), newItem);
    
    const snapshot = await getDocs(collection(db, "menu"));
    const menu = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, menu });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to save menu item", details: error.message });
  }
});

app.delete("/api/menu/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await deleteDoc(doc(db, "menu", id));
    
    const snapshot = await getDocs(collection(db, "menu"));
    const menu = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, menu });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to delete menu item", details: error.message });
  }
});

// 2. Order Endpoints
app.get("/api/orders", async (req, res) => {
  try {
    const snapshot = await getDocs(query(collection(db, "orders"), orderBy("createdAt", "desc")));
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(orders);
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch orders", details: error.message });
  }
});

app.post("/api/orders", async (req, res) => {
  try {
    const orderData = req.body;
    if (!orderData.items || orderData.items.length === 0) {
      return res.status(400).json({ error: "Order items cannot be empty." });
    }

    const orderId = orderData.id || `TX-${Math.floor(1000 + Math.random() * 9000)}`;
    const newOrder = {
      id: orderId,
      items: orderData.items,
      status: orderData.status || "pending",
      total: orderData.total,
      customerName: orderData.customerName,
      customerEmail: orderData.customerEmail,
      customerPhone: orderData.customerPhone,
      blockNumber: orderData.blockNumber || "",
      roomNumber: orderData.roomNumber || "",
      googleMapsAddress: orderData.googleMapsAddress || "",
      specialInstructions: orderData.specialInstructions || "",
      paymentMethod: orderData.paymentMethod || "cash",
      paymentStatus: orderData.paymentStatus || "pending",
      transactionRef: orderData.transactionRef || orderId,
      createdAt: new Date().toISOString(),
      userId: orderData.userId || null,
      serviceTax: orderData.serviceTax || 0,
      flatFee: orderData.flatFee || 0,
      promoCode: orderData.promoCode || null,
      discountAmount: orderData.discountAmount || 0,
      pointsUsed: orderData.pointsUsed || 0,
      pointsEarned: orderData.pointsEarned || 0
    };

    await setDoc(doc(db, "orders", orderId), newOrder);
    await applyLoyaltyAndPromo(newOrder, db);
    
    res.json({ success: true, order: newOrder });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to place order", details: error.message });
  }
});

app.patch("/api/orders/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, paymentStatus, deliveryMinutes } = req.body;

    const updates: any = {};
    if (status) updates.status = status;
    if (paymentStatus) updates.paymentStatus = paymentStatus;

    if (Object.keys(updates).length > 0) {
      await updateDoc(doc(db, "orders", id), updates);
      
      // Trigger Shipday ONLY when status becomes 'ready'
      if (status === "ready") {
        console.log(`[SHIPDAY] Status for ${id} changed to ready. Syncing...`);
        triggerShipday(id, db, deliveryMinutes);
      }
    }
    
    const orderRef = doc(db, "orders", id);
    const docSnap = await getDoc(orderRef);
    res.json({ success: true, order: { id: docSnap.id, ...docSnap.data() } });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to update order", details: error.message });
  }
});

// Chapa Webhook Endpoint
app.post("/api/chapa/webhook", async (req, res) => {
  try {
    const event = req.body;
    const txRef = event.tx_ref || req.body.tx_ref;

    console.log(`[CHAPA WEBHOOK] Received event:`, JSON.stringify(event));

    const status = event.event || event.status;

    if (txRef) {
      const orderRef = doc(db, "orders", txRef);
      const docSnap = await getDoc(orderRef);
      
      if (docSnap.exists()) {
        const orderData = docSnap.data();

        // Handle SUCCESSFUL PAYMENT
        if (status === 'charge.success' || status === 'success') {
          const receiptInfo = {
            transactionId: event.reference || txRef,
            reference: event.reference || txRef,
            amount: event.amount ? parseFloat(event.amount) : (orderData?.total || 0),
            currency: event.currency || "ETB",
            paymentMethod: event.payment_method || event.method || "Chapa",
            fullName: `${event.first_name || ""} ${event.last_name || ""}`.trim() || (orderData?.customerName || ""),
            email: event.email || (orderData?.customerEmail || ""),
            date: event.created_at || new Date().toISOString(),
            status: "success",
            simulated: false
          };

          await updateDoc(orderRef, {
            paymentStatus: "completed",
            status: "pending",
            receipt: receiptInfo,
            updatedAt: new Date().toISOString()
          });
          
          console.log(`[CHAPA WEBHOOK] Successfully verified payment for order ${txRef}`);
          if (orderData.paymentStatus !== "completed") { await applyLoyaltyAndPromo(orderData, db); }
        } 
        
        // Handle REFUND
        else if (status === 'refund.success' || status === 'refunded') {
          console.log(`[CHAPA WEBHOOK] Handling refund event for order ${txRef}`);
          const refundInfo = {
            refundedAt: new Date().toISOString(),
            refundedAmount: event.amount ? parseFloat(event.amount) : (orderData?.total || 0),
            refundReason: event.reason || "Processed via Chapa Dashboard",
            simulated: false,
            webhookData: event
          };

          await updateDoc(orderRef, {
            paymentStatus: "refunded",
            status: "cancelled",
            refund: refundInfo,
            updatedAt: new Date().toISOString()
          });
          console.log(`[CHAPA WEBHOOK] Order ${txRef} marked as refunded via webhook`);
        }
      } else {
        console.warn(`[CHAPA WEBHOOK] Order ${txRef} not found in Firestore`);
      }
    }

    res.status(200).send("Webhook received");
  } catch (error: any) {
    console.error("Webhook processing error:", error.message);
    res.status(500).send("Server Error");
  }
});

// Chapa Initialize
app.post("/api/chapa/initialize", async (req, res) => {
  try {
    const { amount, email, first_name, last_name, phone_number, items } = req.body;

    if (!amount || !email || !first_name || !last_name) {
      return res.status(400).json({ error: "Missing required Chapa initiation parameters." });
    }

    const tx_ref = `tx-savory-${Date.now()}`;
    const chapaKey = process.env.CHAPA_SECRET_KEY;

    // Dynamically detect the base URL of the request (works across development and preview containers)
    const requestHost = req.headers.host || "ais-pre-x3ydxtiptsndkmo4idfvrk-375232154731.europe-west2.run.app";
    const requestProto = (req.headers['x-forwarded-proto'] as string) || req.protocol || "https";
    const requestOrigin = `${requestProto}://${requestHost}`;
    const baseUrl = process.env.APP_URL || requestOrigin;
    
    console.log(`[CHAPA INITIALIZE] Base URL resolved to: ${baseUrl} (Host: ${requestHost}, Proto: ${requestProto})`);

    const chapaPayload = {
      amount: amount.toString(),
      currency: "ETB",
      email: email,
      first_name: first_name,
      last_name: last_name,
      phone_number: phone_number || "",
      tx_ref: tx_ref,
      callback_url: `${baseUrl}/api/chapa/webhook`,
      return_url: `${baseUrl}/?status=success&tx_ref=${tx_ref}`,
      customization: {
        title: "Savory Order",
        description: `Payment for ${items?.length || 1} items`
      }
    };

    const newOrder = {
      id: tx_ref,
      items: items || [],
      status: "pending",
      total: parseFloat(amount),
      customerName: `${first_name} ${last_name}`,
      customerEmail: email,
      customerPhone: phone_number || "",
      blockNumber: req.body.blockNumber || "",
      roomNumber: req.body.roomNumber || "",
      googleMapsAddress: req.body.googleMapsAddress || "",
      specialInstructions: req.body.specialInstructions || "",
      paymentMethod: "chapa",
      paymentStatus: "pending",
      transactionRef: tx_ref,
      createdAt: new Date().toISOString(),
      userId: req.body.userId || null,
      serviceTax: req.body.serviceTax || 0,
      flatFee: req.body.flatFee || 0,
      promoCode: req.body.promoCode || null,
      discountAmount: req.body.discountAmount || 0,
      pointsUsed: req.body.pointsUsed || 0,
      pointsEarned: req.body.pointsEarned || 0
    };

    await setDoc(doc(db, "orders", tx_ref), newOrder);

    if (chapaKey && chapaKey !== "MY_CHAPA_SECRET_KEY" && !chapaKey.startsWith("CHAPASECKEY-xxxx")) {
      console.log(`[CHAPA] Attempting real payment initiation for reference ${tx_ref}`);
      try {
        const response = await fetch("https://api.chapa.co/v1/transaction/initialize", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${chapaKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(chapaPayload)
        });

        const chapaData = await response.json();
        
        if (chapaData.status === "success" && chapaData.data?.checkout_url) {
          await updateDoc(doc(db, "orders", tx_ref), { chapaCheckoutUrl: chapaData.data.checkout_url });
          return res.json({ success: true, checkoutUrl: chapaData.data.checkout_url, txRef: tx_ref, simulated: false });
        } else {
          return res.status(400).json({ success: false, error: chapaData.message || "Chapa API initialization failed", details: chapaData });
        }
      } catch (err: any) {
        return res.status(500).json({ success: false, error: "Chapa connection failed: " + err.message });
      }
    } else {
      return res.status(400).json({ success: false, error: "Missing CHAPA_SECRET_KEY in the backend environment." });
    }
  } catch (error: any) {
    res.status(500).json({ error: "Failed to initialize payment", details: error.message });
  }
});

// Callback verification from Chapa
app.get("/api/chapa/verify/:txRef", async (req, res) => {
  console.log(`[CHAPA VERIFY] Verification request received for txRef: ${req.params.txRef}`);
  try {
    const { txRef } = req.params;
    const chapaKey = process.env.CHAPA_SECRET_KEY;

    const orderRef = doc(db, "orders", txRef);
    const docSnap = await getDoc(orderRef);

    if (!docSnap.exists()) {
      console.warn(`[CHAPA VERIFY] Order with txRef: ${txRef} not found in Firestore`);
      return res.status(404).json({ error: "Order or transaction reference not found" });
    }

    console.log(`[CHAPA VERIFY] Order found. Current payment status: ${docSnap.data()?.paymentStatus}`);

    if (chapaKey && chapaKey !== "MY_CHAPA_SECRET_KEY" && !chapaKey.startsWith("CHAPASECKEY-xxxx")) {
      console.log(`[CHAPA VERIFY] Real Chapa Secret Key detected. Fetching verification from Chapa API...`);
      try {
        const response = await fetch(`https://api.chapa.co/v1/transaction/verify/${txRef}`, {
          method: "GET",
          headers: { "Authorization": `Bearer ${chapaKey}` }
        });

        console.log(`[CHAPA VERIFY] Chapa API status code: ${response.status}`);
        const chapaData = await response.json();
        console.log(`[CHAPA VERIFY] Chapa API response body:`, JSON.stringify(chapaData));

        if (chapaData.status === "success" && chapaData.data?.status === "success") {
          console.log(`[CHAPA VERIFY] Payment verified successfully! Updating Firestore to completed.`);
          const rawData = chapaData.data;
          const orderData = docSnap.data();
          const receiptInfo = {
            transactionId: rawData.reference || txRef,
            reference: rawData.reference || txRef,
            amount: rawData.amount ? parseFloat(rawData.amount) : (orderData?.total || 0),
            currency: rawData.currency || "ETB",
            paymentMethod: rawData.payment_method || rawData.method || "Chapa",
            fullName: `${rawData.first_name || ""} ${rawData.last_name || ""}`.trim() || (orderData?.customerName || ""),
            email: rawData.email || (orderData?.customerEmail || ""),
            date: rawData.created_at || new Date().toISOString(),
            status: "success",
            simulated: false
          };

          await updateDoc(orderRef, { 
            paymentStatus: "completed", 
            status: "pending",
            receipt: receiptInfo
          });
          if (orderData.paymentStatus !== "completed") { await applyLoyaltyAndPromo(orderData, db); }

          const updatedDoc = await getDoc(orderRef);
          return res.json({ success: true, status: "completed", order: { id: updatedDoc.id, ...updatedDoc.data() } });
        } else {
          console.warn(`[CHAPA VERIFY] Chapa API verification returned non-success structure or status. Data status: ${chapaData.data?.status}`);
          return res.status(400).json({ success: false, status: "pending", error: "Payment not completed yet" });
        }
      } catch (err: any) {
        console.error("[CHAPA VERIFY] Verification network/JSON error:", err.message);
        return res.status(500).json({ success: false, error: "Network error during verification" });
      }
    } else {
      console.log(`[CHAPA VERIFY] No real Chapa Secret Key detected. Using simulation mode.`);
      console.log(`[CHAPA VERIFY] Falling back to updating Firestore to completed (simulated/forced).`);
      const orderData = docSnap.data();
      const receiptInfo = {
        transactionId: `sim-ref-${txRef}`,
        reference: txRef,
        amount: orderData?.total || 0,
        currency: "ETB",
        paymentMethod: "Chapa (Simulated CBE Birr / Telebirr)",
        fullName: orderData?.customerName || "Simulated Customer",
        email: orderData?.customerEmail || "simulated@example.com",
        date: new Date().toISOString(),
        status: "success",
        simulated: true
      };

      await updateDoc(orderRef, { 
        paymentStatus: "completed", 
        status: "pending",
        receipt: receiptInfo
      });
      if (orderData.paymentStatus !== "completed") { await applyLoyaltyAndPromo(orderData, db); }
      const finalDoc = await getDoc(orderRef);
      return res.json({ success: true, status: "completed", order: { id: finalDoc.id, ...finalDoc.data() }, simulated: true });
    }
  } catch (error: any) {
    console.error(`[CHAPA VERIFY] Fatal error during verification:`, error.message);
    res.status(500).json({ error: "Verification failed", details: error.message });
  }
});

// Refund endpoint for Chapa
app.post("/api/chapa/refund", async (req, res) => {
  console.log(`[CHAPA REFUND] Refund request received:`, req.body);
  try {
    const { txRef, amount } = req.body;
    if (!txRef) {
      return res.status(400).json({ error: "Transaction reference (txRef) is required" });
    }

    const chapaKey = process.env.CHAPA_SECRET_KEY;
    const orderRef = doc(db, "orders", txRef);
    const docSnap = await getDoc(orderRef);

    if (!docSnap.exists()) {
      return res.status(404).json({ error: "Order not found" });
    }

    const orderData = docSnap.data();
    if (orderData.paymentStatus === "refunded") {
      return res.status(400).json({ error: "Order has already been refunded" });
    }

    if (orderData.paymentStatus !== "completed") {
      return res.status(400).json({ error: "Only fully completed payments can be refunded" });
    }

    const refundAmount = amount !== undefined ? parseFloat(amount) : orderData.total;
    if (isNaN(refundAmount) || refundAmount <= 0) {
      return res.status(400).json({ error: "Invalid refund amount" });
    }

    if (chapaKey && chapaKey !== "MY_CHAPA_SECRET_KEY" && !chapaKey.startsWith("CHAPASECKEY-xxxx")) {
      console.log(`[CHAPA REFUND] Real Chapa Secret Key detected. Requesting refund from Chapa API...`);
      try {
        // Primary attempt: v1/transaction/refund (Standard for actions)
        let response = await fetch("https://api.chapa.co/v1/transaction/refund", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${chapaKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            transaction_id: txRef,
            amount: refundAmount
          })
        });

        console.log(`[CHAPA REFUND] Primary API (v1/transaction/refund) status: ${response.status}`);
        
        // If primary fails with 405 (Method Not Allowed) or 404, try singular v1/refund as fallback
        if (response.status === 405 || response.status === 404) {
          console.log(`[CHAPA REFUND] v1/transaction/refund not supported. Trying fallback v1/refund (singular)...`);
          response = await fetch("https://api.chapa.co/v1/refund", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${chapaKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              transaction_id: txRef,
              amount: refundAmount
            })
          });
          console.log(`[CHAPA REFUND] Fallback API (v1/refund) status: ${response.status}`);
        }

        let chapaData: any = {};
        try {
          chapaData = await response.json();
        } catch (e) {
          chapaData = { message: "Failed to parse API JSON response" };
        }
        console.log(`[CHAPA REFUND] Final Chapa API response body:`, JSON.stringify(chapaData));

        if (response.ok && chapaData.status === "success") {
          console.log(`[CHAPA REFUND] Refund successful! Updating Firestore order payment status.`);
          const refundInfo = {
            refundedAt: new Date().toISOString(),
            refundedAmount: refundAmount,
            refundReason: req.body.reason || "Customer request",
            simulated: false,
            chapaResponse: chapaData
          };

          await updateDoc(orderRef, {
            paymentStatus: "refunded",
            status: "cancelled", 
            refund: refundInfo
          });

          const updatedDoc = await getDoc(orderRef);
          return res.json({ success: true, message: "Refund processed successfully via Chapa!", order: { id: updatedDoc.id, ...updatedDoc.data() } });
        } else {
          console.warn(`[CHAPA REFUND] Chapa API refund failed. Status: ${response.status}. Data:`, chapaData);
          
          const isMethodNotSupported = (response.status === 405) || 
                                       (chapaData.message && chapaData.message.toLowerCase().includes("not supported")) ||
                                       (chapaData.error && chapaData.error.toLowerCase().includes("not supported"));

          if (isMethodNotSupported || response.status === 404) {
            return res.status(405).json({ 
              success: false, 
              error: "Chapa's API does not support programmatic refunds for this account type or in test mode.",
              message: "Please complete the refund manually in your Chapa Merchant Dashboard. The order status has NOT been changed."
            });
          }

          return res.status(400).json({ success: false, error: chapaData.message || "Chapa Refund API call failed", details: chapaData });
        }
      } catch (err: any) {
        console.error("[CHAPA REFUND] Refund network/JSON error:", err.message);
        return res.status(500).json({ success: false, error: "Network error during refund request. No changes were made to the order." });
      }
    } else {
      console.log(`[CHAPA REFUND] No real Chapa Secret Key detected. Simulating refund...`);
      const refundInfo = {
        refundedAt: new Date().toISOString(),
        refundedAmount: refundAmount,
        refundReason: req.body.reason || "Customer request (Simulated)",
        simulated: true
      };

      await updateDoc(orderRef, {
        paymentStatus: "refunded",
        status: "cancelled",
        refund: refundInfo
      });

      const updatedDoc = await getDoc(orderRef);
      return res.json({ success: true, message: "Refund processed successfully (Simulated)", order: { id: updatedDoc.id, ...updatedDoc.data() }, simulated: true });
    }
  } catch (error: any) {
    console.error(`[CHAPA REFUND] Fatal error during refund:`, error.message);
    res.status(500).json({ error: "Refund failed", details: error.message });
  }
});

// 3. Checkout Settings Endpoints
app.get("/api/settings", async (req, res) => {
  try {
    const docSnap = await getDoc(doc(db, "settings", "checkout"));
    if (docSnap.exists()) {
      res.json(docSnap.data());
    } else {
      res.json({ serviceTaxPercent: 15, flatFeeETB: 0, shipdayDeliveryMinutes: 20, isOpen: true });
    }
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch checkout settings", details: error.message });
  }
});

app.post("/api/settings", async (req, res) => {
  try {
    const { serviceTaxPercent, flatFeeETB, shipdayDeliveryMinutes, isOpen } = req.body;
    const settings = {
      serviceTaxPercent: parseFloat(serviceTaxPercent) || 0,
      flatFeeETB: parseFloat(flatFeeETB) || 0,
      shipdayDeliveryMinutes: parseInt(shipdayDeliveryMinutes) || 20,
      shipdayPickupMinutes: parseInt(req.body.shipdayPickupMinutes) || 10,
      enableCOD: req.body.enableCOD !== undefined ? req.body.enableCOD : true,
      isOpen: isOpen !== undefined ? isOpen : true,
      updatedAt: new Date().toISOString()
    };
    await setDoc(doc(db, "settings", "checkout"), settings);
    res.json({ success: true, settings });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to save checkout settings", details: error.message });
  }
});

// Mailchimp Connection Test Endpoint
app.get("/api/mailchimp/test", async (req, res) => {
  try {
    const apiKey = process.env.MAILCHIMP_API_KEY;
    const listId = process.env.MAILCHIMP_LIST_ID;

    if (!apiKey || !listId || apiKey === "YOUR_MAILCHIMP_API_KEY") {
      return res.status(400).json({ 
        success: false, 
        error: "Mailchimp is not configured in the environment variables." 
      });
    }

    const datacenter = apiKey.split("-")[1] || "us1";
    const mailchimpUrl = `https://${datacenter}.api.mailchimp.com/3.0/lists/${listId}`;
    
    const response = await fetch(mailchimpUrl, {
      method: "GET",
      headers: {
        "Authorization": `Basic ${Buffer.from(`anystring:${apiKey}`).toString('base64')}`,
        "Content-Type": "application/json"
      }
    });

    const data = await response.json();
    
    if (response.ok) {
      res.json({ success: true, message: `Connected to Mailchimp! List: ${data.name}` });
    } else {
      res.status(400).json({ success: false, error: data.title || "Mailchimp connection failed" });
    }
  } catch (error: any) {
    res.status(500).json({ success: false, error: "Test failed: " + error.message });
  }
});

// 4. Shipday API Integration
app.post("/api/shipday/order", async (req, res) => {
  try {
    const settingsSnap = await getDoc(doc(db, "settings", "checkout"));
    const settings = settingsSnap.exists() ? settingsSnap.data() : {};
    
    const shipdayKey = process.env.SHIPDAY_API_KEY || settings.shipdayApiKey;
    if (!shipdayKey) {
      return res.status(500).json({ 
        error: "Shipday API is not configured.", 
        details: "Please add your SHIPDAY_API_KEY to the environment secrets."
      });
    }

    const { orderData } = req.body;
    if (!orderData) {
      return res.status(400).json({ error: "Order data is required." });
    }

    console.log(`[SHIPDAY] Sending order ${orderData.id} to Shipday using axios...`);

    const shipdayResponse = await axios.post(
      "https://api.shipday.com/orders", 
      {
        orderNumber: String(orderData.id),
        customerName: orderData.customerName,
        customerAddress: orderData.googleMapsAddress || "No address provided",
        customerEmail: orderData.customerEmail || "",
        customerPhoneNumber: orderData.customerPhone,
        restaurantName: "Savory VPS",
        restaurantAddress: "Addis Ababa, Ethiopia",
        orderItems: (orderData.items || []).map((item: { name: string; price: number; quantity?: number }) => ({
          name: item.name,
          unitPrice: item.price,
          quantity: item.quantity || 1
        })),
        totalOrderCost: orderData.total,
        deliveryFee: orderData.flatFee || 0,
        tax: orderData.serviceTax || 0
      },
      {
        headers: {
          "Authorization": "Basic " + shipdayKey,
          "Content-Type": "application/json"
        }
      }
    );

    const data = shipdayResponse.data;
    console.log(`[SHIPDAY] Order ${orderData.id} successfully created in Shipday.`);
    
    // Update order in Firestore with Shipday info
    if (data.orderId) {
      await setDoc(doc(db, "orders", orderData.id), {
        shipdayOrderId: data.orderId,
        shipdayStatus: "created",
        shipdayTrackingLink: data.trackingLink || data.shortTrackingLink || null,
        shipdayLastUpdate: new Date().toISOString()
      }, { merge: true });
    }

    res.json({ success: true, shipdayData: data });
  } catch (error: any) {
    console.error("[SHIPDAY] API Error Details:", error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ 
      error: "Failed to connect to Shipday", 
      details: error.response?.data || error.message 
    });
  }
});

app.get("/api/shipday/test", async (req, res) => {
  try {
    const settingsSnap = await getDoc(doc(db, "settings", "checkout"));
    const settings = settingsSnap.exists() ? settingsSnap.data() : {};
    
    const shipdayKey = process.env.SHIPDAY_API_KEY || settings.shipdayApiKey; 
    
    if (!shipdayKey || shipdayKey === "") {
      return res.status(400).json({ 
        success: false,
        error: "Shipday API key not found in environment secrets.",
        hint: "Please ensure SHIPDAY_API_KEY is configured in the environment."
      });
    }

    console.log(`[SHIPDAY TEST] Testing connectivity to Shipday...`);
    const shipdayResponse = await axios.get("https://api.shipday.com/orders", {
      headers: {
        "Authorization": "Basic " + shipdayKey
      }
    });

    const orders = shipdayResponse.data;
    const orderCount = Array.isArray(orders) ? orders.length : 0;

    res.json({ 
      success: true, 
      message: "Successfully connected to Shipday API", 
      orderCount: orderCount
    });
  } catch (error: any) {
    console.error("[SHIPDAY TEST] Error details:", error.response?.data || error.message);
    
    let errorMessage = "Connection failed. Check your API key.";
    if (error.response?.status === 401) {
      errorMessage = "Invalid API Key (Unauthorized).";
    } else if (error.code === 'ENOTFOUND') {
      errorMessage = "Could not reach Shipday API (Network Error).";
    }

    res.status(400).json({ 
      success: false, 
      error: errorMessage,
      details: error.response?.data || error.message
    });
  }
});

// Shipday Webhook Receiver
app.post("/api/shipday/webhook", async (req, res) => {
  try {
    const token = req.query.token || req.headers['x-shipday-token'];
    const expectedToken = process.env.SHIPDAY_WEBHOOK_TOKEN ? String(process.env.SHIPDAY_WEBHOOK_TOKEN).trim() : "";

    // Only verify if a token is configured in environment as a non-empty string
    if (expectedToken && expectedToken !== "" && token !== expectedToken) {
      console.warn("[SHIPDAY WEBHOOK] Unauthorized access attempt with invalid token.");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const payload = req.body;
    console.log("[SHIPDAY WEBHOOK] Received payload:", JSON.stringify(payload, null, 2));

    // Helper to extract values from nested or top-level objects in the webhook payload
    const extractValue = (obj: any, keys: string[]): any => {
      if (!obj || typeof obj !== 'object') return undefined;
      for (const key of keys) {
        if (obj[key] !== undefined) return obj[key];
      }
      // Check common nested structures like obj.order, obj.data, etc.
      const nestedContainers = ['order', 'data', 'eventData', 'payload'];
      for (const container of nestedContainers) {
        if (obj[container] && typeof obj[container] === 'object') {
          const val = extractValue(obj[container], keys);
          if (val !== undefined) return val;
        }
      }
      return undefined;
    };

    // Extract orderNumber/orderId and status robustly
    const orderIdRaw = extractValue(payload, ['orderNumber', 'order_number', 'orderId', 'order_id', 'id']);
    const shipdayStatusRaw = extractValue(payload, ['status', 'orderStatus', 'order_status', 'state', 'event', 'deliveryStatus', 'delivery_status']);

    if (orderIdRaw && shipdayStatusRaw) {
      const orderId = String(orderIdRaw).trim();
      const shipdayStatus = String(shipdayStatusRaw).trim();

      console.log(`[SHIPDAY WEBHOOK] Found order ${orderId} and status: ${shipdayStatus}`);
      const orderRef = doc(db, "orders", orderId);
      
      const updateData: any = {
        shipdayStatus: shipdayStatus,
        shipdayLastUpdate: new Date().toISOString()
      };

      // Clean up the status string to make comparisons more forgiving
      const normalizedStatus = shipdayStatus
        .toUpperCase()
        .replace(/[.\-\s]+/g, '_')
        .trim();

      console.log(`[SHIPDAY WEBHOOK] Normalized status for order ${orderId}: ${normalizedStatus}`);
      
      const completionStatuses = [
        "COMPLETED", 
        "DELIVERED", 
        "COMPLETE", 
        "DONE", 
        "FINISHED", 
        "DELIVERY_COMPLETED", 
        "ORDER_COMPLETED",
        "SUCCESS", 
        "SUCCESSFUL", 
        "ALREADY_DELIVERED"
      ];
      const cancellationStatuses = [
        "CANCELLED", 
        "CANCELED",
        "DELETED", 
        "REJECTED", 
        "FAILED", 
        "NOT_DELIVERED",
        "DELIVERY_FAILED",
        "ORDER_CANCELLED"
      ];
      const activeStatuses = [
        "ASSIGNED", 
        "STARTED", 
        "PICKED_UP", 
        "ARRIVED", 
        "ACTIVE", 
        "DISPATCHED", 
        "ON_THE_WAY", 
        "IN_TRANSIT", 
        "OUT_FOR_DELIVERY",
        "PICKUP"
      ];

      if (completionStatuses.includes(normalizedStatus)) {
        updateData.status = "delivered";
        console.log(`[SHIPDAY WEBHOOK] Mapping ${normalizedStatus} to delivered for ${orderId}`);
      } else if (cancellationStatuses.includes(normalizedStatus)) {
        updateData.status = "cancelled";
        console.log(`[SHIPDAY WEBHOOK] Mapping ${normalizedStatus} to cancelled for ${orderId}`);
      } else if (activeStatuses.includes(normalizedStatus)) {
        // Only update to preparing if it's currently pending
        // We want to avoid downgrading 'ready' or 'delivered'
        try {
          const currentSnap = await getDoc(orderRef);
          if (currentSnap.exists()) {
            const currentStatus = currentSnap.data().status;
            if (currentStatus === "pending") {
              updateData.status = "preparing";
              console.log(`[SHIPDAY WEBHOOK] Mapping ${normalizedStatus} to preparing for ${orderId} (current: ${currentStatus})`);
            } else {
              console.log(`[SHIPDAY WEBHOOK] Skipping status update for ${orderId}. Current status is ${currentStatus}, webhook status is ${normalizedStatus}`);
            }
          }
        } catch (e) {
          console.error("[SHIPDAY WEBHOOK] Error checking current status:", e);
        }
      }

      await setDoc(orderRef, updateData, { merge: true });
      console.log(`[SHIPDAY WEBHOOK] Order ${orderId} successfully updated in Firestore with status: ${normalizedStatus}`);
    } else {
      console.warn(`[SHIPDAY WEBHOOK] Webhook received but orderIdRaw (${orderIdRaw}) or shipdayStatusRaw (${shipdayStatusRaw}) is missing.`, payload);
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error("[SHIPDAY WEBHOOK] Error processing webhook:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Vite or Static Files Handler
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    console.log("[VITE] Mounted dev middleware successfully");
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[SERVER] Ready! Savory VPS Server running on http://localhost:${PORT}`);
  });
}

startServer();
