import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { isFirebaseConfigured, storage } from '../firebase';

export async function uploadSettingsImage(
  branchId: string,
  file: File,
  kind: 'branch-logo' | 'receipt-logo',
): Promise<string> {
  if (!isFirebaseConfigured || !storage) {
    return URL.createObjectURL(file);
  }

  const ext = file.name.split('.').pop() ?? 'png';
  const path = `branches/${branchId}/${kind}.${ext}`;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file, { contentType: file.type });
  return getDownloadURL(storageRef);
}
