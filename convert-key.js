const bs58 = require('bs58');
const fs = require('fs');

// Replace with your base58 private key
const base58Key = 'K1tqWSW6rgJimkXPrPNfKS9WhXuZ9qhHLaE3jnWpSv6hycmhsedktYxp1cjWMgYeGn1o3fRE1ozc5JiJy3iu79H';
const byteArray = Array.from(bs58.decode(base58Key));
console.log(JSON.stringify(byteArray));