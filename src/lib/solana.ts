import { 
  Connection, 
  Keypair, 
  PublicKey, 
  LAMPORTS_PER_SOL,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction
} from '@solana/web3.js';
import bs58 from 'bs58';

// Initialize Solana connection
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
export const connection = new Connection(RPC_URL, 'confirmed');

// Load escrow wallet from private key
export function getEscrowKeypair(): Keypair {
  const privateKey = process.env.ESCROW_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('ESCROW_PRIVATE_KEY not set in environment');
  }
  const secretKey = bs58.decode(privateKey);
  return Keypair.fromSecretKey(secretKey);
}

// Get escrow wallet public key
export function getEscrowPublicKey(): PublicKey {
  const address = process.env.ESCROW_WALLET_ADDRESS;
  if (!address) {
    throw new Error('ESCROW_WALLET_ADDRESS not set in environment');
  }
  return new PublicKey(address);
}

// Get house wallet public key
export function getHousePublicKey(): PublicKey {
  const address = process.env.HOUSE_WALLET_ADDRESS;
  if (!address) {
    throw new Error('HOUSE_WALLET_ADDRESS not set in environment');
  }
  return new PublicKey(address);
}

// Get SOL balance for an address
export async function getSolBalance(address: string): Promise<number> {
  const publicKey = new PublicKey(address);
  const balance = await connection.getBalance(publicKey);
  return balance / LAMPORTS_PER_SOL;
}

// Verify a transaction signature
export async function verifyTransaction(signature: string): Promise<{
  confirmed: boolean;
  slot?: number;
  blockTime?: number;
}> {
  try {
    const status = await connection.getSignatureStatus(signature);
    
    if (status.value?.confirmationStatus === 'confirmed' || 
        status.value?.confirmationStatus === 'finalized') {
      const transaction = await connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0
      });
      
      return {
        confirmed: true,
        slot: transaction?.slot,
        blockTime: transaction?.blockTime || undefined
      };
    }
    
    return { confirmed: false };
  } catch (error) {
    console.error('Error verifying transaction:', error);
    return { confirmed: false };
  }
}

// Transfer SOL from escrow to a destination
export async function transferFromEscrow(
  destinationAddress: string,
  amountSol: number
): Promise<string> {
  const escrowKeypair = getEscrowKeypair();
  const destinationPubkey = new PublicKey(destinationAddress);
  
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: escrowKeypair.publicKey,
      toPubkey: destinationPubkey,
      lamports: Math.floor(amountSol * LAMPORTS_PER_SOL)
    })
  );
  
  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    [escrowKeypair]
  );
  
  return signature;
}

// Lamports to SOL conversion
export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

// SOL to Lamports conversion
export function solToLamports(sol: number): number {
  return Math.floor(sol * LAMPORTS_PER_SOL);
}
