export async function encodeFile(file: File | Blob): Promise<string> {
  if (file.size > 5 * 1024 * 1024) throw new Error('Fichier supérieur à 5 Mio');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Fichier illisible'));
    reader.readAsDataURL(file);
  });
}
