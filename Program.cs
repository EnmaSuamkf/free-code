using System;

namespace MiPrimeraApp
{
    class Program
    {
        static void Main(string[] args)
        {
            Console.WriteLine("¡Hola! Bienvenido a .NET");
            Console.Write("¿Cómo te llamas? ");
            string nombre = Console.ReadLine();
            
            Console.WriteLine($"Encantado de conocerte, {nombre}!");
            
            // Ejemplo de una clase simple
            Persona persona = new Persona(nombre);
            persona.Saludar();
        }
    }
    
    class Persona
    {
        public string Nombre { get; set; }
        
        public Persona(string nombre)
        {
            Nombre = nombre;
        }
        
        public void Saludar()
        {
            Console.WriteLine($"Hola desde la clase Persona. Mi nombre es {Nombre}");
        }
    }
}
