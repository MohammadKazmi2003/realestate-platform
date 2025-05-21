// src/app/upload/page.tsx
import ImageUpload from '@/app/components/ImageUpload'


export default function UploadPage() {
  return (
    <main className="p-6">
      <h1 className="text-3xl font-bold mb-4">Upload Property Image</h1>
      <ImageUpload propertyId="test-property-id" />
    </main>
  )
}
