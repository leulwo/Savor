const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf-8');

// Replace standard admin SDK calls with client SDK calls
content = content.replace(/db\.collection\("menu"\)\.get\(\)/g, 'getDocs(collection(db, "menu"))');
content = content.replace(/db\.collection\("menu"\)\.doc\(([^)]+)\)\.set\(([^)]+)\)/g, 'setDoc(doc(db, "menu", $1), $2)');
content = content.replace(/db\.collection\("menu"\)\.doc\(([^)]+)\)\.delete\(\)/g, 'deleteDoc(doc(db, "menu", $1))');

content = content.replace(/db\.collection\('orders'\)\.doc\(([^)]+)\)\.get\(\)/g, 'getDoc(doc(db, "orders", $1))');
content = content.replace(/db\.collection\("orders"\)\.doc\(([^)]+)\)\.get\(\)/g, 'getDoc(doc(db, "orders", $1))');

content = content.replace(/db\.collection\("orders"\)\.doc\(([^)]+)\)\.set\(([^)]+)\)/g, 'setDoc(doc(db, "orders", $1), $2)');
content = content.replace(/db\.collection\('orders'\)\.doc\(([^)]+)\)\.set\(([^)]+)\)/g, 'setDoc(doc(db, "orders", $1), $2)');

content = content.replace(/db\.collection\("orders"\)\.doc\(([^)]+)\)\.update\(([^)]+)\)/g, 'updateDoc(doc(db, "orders", $1), $2)');
content = content.replace(/await orderRef\.update\(([^)]+)\)/g, 'await updateDoc(orderRef, $1)');
content = content.replace(/await orderRef\.get\(\)/g, 'await getDoc(orderRef)');
content = content.replace(/const orderRef = db\.collection\('orders'\)\.doc\(([^)]+)\);/g, 'const orderRef = doc(db, "orders", $1);');
content = content.replace(/const snapshot = await db\.collection\("orders"\)\.orderBy\("createdAt", "desc"\)\.get\(\);/g, `import { query, orderBy } from "firebase/firestore";\n    const snapshot = await getDocs(query(collection(db, "orders"), orderBy("createdAt", "desc")));`);

fs.writeFileSync('server.ts', content);
